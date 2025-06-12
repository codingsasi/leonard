const { App } = require('@slack/bolt');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Per-thread queue system to handle concurrent requests
const threadQueues = new Map(); // Map of threadId -> { queue: [], isProcessing: false }

// Function to process queue for a specific thread
async function processThreadQueue(openaiThreadId) {
  const threadQueue = threadQueues.get(openaiThreadId);
  if (!threadQueue || threadQueue.isProcessing || threadQueue.queue.length === 0) {
    return;
  }

  threadQueue.isProcessing = true;
  console.log(`🔄 Processing queue for thread ${openaiThreadId} (${threadQueue.queue.length} items)`);

  while (threadQueue.queue.length > 0) {
    const { fn, resolve, reject } = threadQueue.queue.shift();
    try {
      console.log(`⚡ Processing request for OpenAI thread: ${openaiThreadId}`);
      const result = await fn();
      resolve(result);
    } catch (error) {
      console.error(`❌ Queue processing error for thread ${openaiThreadId}:`, error);
      reject(error);
    }
  }

  threadQueue.isProcessing = false;
  console.log(`✅ Queue processing completed for thread ${openaiThreadId}`);

  // Clean up empty queues
  if (threadQueue.queue.length === 0) {
    threadQueues.delete(openaiThreadId);
  }
}

// Function to add request to per-thread queue
function queueThreadRequest(fn, openaiThreadId) {
  return new Promise((resolve, reject) => {
    if (!threadQueues.has(openaiThreadId)) {
      threadQueues.set(openaiThreadId, { queue: [], isProcessing: false });
    }

    const threadQueue = threadQueues.get(openaiThreadId);
    threadQueue.queue.push({ fn, resolve, reject });

    console.log(`➕ Added request to queue for OpenAI thread: ${openaiThreadId} (queue size: ${threadQueue.queue.length})`);
    processThreadQueue(openaiThreadId);
  });
}

// Load prompts from JSON file
const prompts = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'prompts.json'), 'utf8'));

// Load global configuration
let globalConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'global-config.json'), 'utf8'));

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Slack app
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN
});

// Function to save global configuration
function saveGlobalConfig() {
  try {
    globalConfig.statistics.last_updated = new Date().toISOString();
    fs.writeFileSync(
      path.join(__dirname, 'data', 'global-config.json'),
      JSON.stringify(globalConfig, null, 2)
    );
    console.log('💾 Global config saved');
  } catch (error) {
    console.error('❌ Error saving global config:', error);
  }
}

// Function to get thread filename from Slack thread ID
function getThreadFilename(slackThreadId) {
  return path.join(__dirname, 'data', 'threads', `sl-${slackThreadId}.json`);
}

// Function to load thread data from individual file
function loadThreadData(slackThreadId) {
  try {
    const filename = getThreadFilename(slackThreadId);
    if (fs.existsSync(filename)) {
      const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
      console.log('📂 Loaded thread data for:', slackThreadId);
      return data;
    }
    return null;
  } catch (error) {
    console.error('❌ Error loading thread data:', error);
    return null;
  }
}

// Function to save thread data to individual file
function saveThreadData(slackThreadId, threadData) {
  try {
    const filename = getThreadFilename(slackThreadId);
    const data = {
      ...threadData,
      last_updated: new Date().toISOString()
    };
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));
    console.log('💾 Saved thread data for:', slackThreadId);
  } catch (error) {
    console.error('❌ Error saving thread data:', error);
  }
}

// Function to fetch Slack thread messages since a specific timestamp
async function getSlackThreadMessagesSince(client, channel, threadTs, sinceTs = null) {
  try {
    console.log('📥 Fetching Slack thread messages since:', sinceTs || 'beginning');

    const result = await client.conversations.replies({
      channel: channel,
      ts: threadTs,
      inclusive: true,
      oldest: sinceTs || undefined
    });

    if (!result.messages || result.messages.length === 0) {
      console.log('📭 No new messages found in thread');
      return [];
    }

    // Filter out bot messages to avoid feedback loops
    const authResult = await client.auth.test();
    const botUserId = authResult.user_id;

    const filteredMessages = result.messages.filter(msg => {
      // Skip bot's own messages
      if (msg.user === botUserId) return false;

      // If we have a sinceTs, only include messages newer than it
      if (sinceTs && parseFloat(msg.ts) <= parseFloat(sinceTs)) return false;

      return true;
    });

    console.log(`📨 Found ${filteredMessages.length} new messages to sync`);
    return filteredMessages;
  } catch (error) {
    console.error('❌ Error fetching Slack thread messages:', error);
    return [];
  }
}

// Function to sync new Slack messages to OpenAI thread
async function syncSlackMessagesToOpenAI(client, channel, slackThreadId, openaiThreadId) {
  try {
    // Get thread data to find last processed timestamp
    const threadData = loadThreadData(slackThreadId);
    const lastProcessedTs = threadData?.last_processed_message_ts;

    console.log('🔄 Syncing messages since:', lastProcessedTs || 'beginning');

    // Fetch new messages since last processed timestamp
    const newMessages = await getSlackThreadMessagesSince(client, channel, slackThreadId, lastProcessedTs);

    if (newMessages.length === 0) {
      console.log('✅ Thread already up to date');
      return threadData?.last_processed_message_ts;
    }

    // Add each new message to the OpenAI thread
    let latestTs = lastProcessedTs;
    for (const message of newMessages) {
      // Format the message for context
      const contextMessage = `[${message.user}]: ${message.text}`;

      await openai.beta.threads.messages.create(openaiThreadId, {
        role: "user",
        content: `Context from Slack thread: ${contextMessage}`
      });

      latestTs = message.ts;
      console.log(`📝 Synced message from ${message.user}`);
    }

    // Update thread data with latest processed timestamp
    const updatedThreadData = {
      ...(threadData || {}),
      last_processed_message_ts: latestTs
    };
    saveThreadData(slackThreadId, updatedThreadData);

    console.log(`✅ Synced ${newMessages.length} new messages to OpenAI thread`);
    return latestTs;
  } catch (error) {
    console.error('❌ Error syncing messages to OpenAI:', error);
    return null;
  }
}

// Function to create or get OpenAI Assistant
async function getOrCreateAssistant() {
  try {
    // If we already have an assistant ID in global config, try to retrieve it
    if (globalConfig.assistant_id) {
      try {
        const assistant = await openai.beta.assistants.retrieve(globalConfig.assistant_id);
        console.log('🤖 Using existing assistant:', assistant.id);
        return assistant;
      } catch (error) {
        console.log('⚠️ Existing assistant not found, creating new one');
        globalConfig.assistant_id = null;
      }
    }

    // Create new assistant
    console.log('🚀 Creating new OpenAI Assistant...');
    const assistant = await openai.beta.assistants.create({
      name: globalConfig.bot_settings.name,
      instructions: prompts.system_prompt,
      model: globalConfig.bot_settings.model,
      tools: [],
      response_format: { type: "text" }
    });

    // Save the assistant ID and settings to global config
    globalConfig.assistant_id = assistant.id;
    globalConfig.bot_settings.created_at = new Date().toISOString();
    globalConfig.bot_settings.last_updated = new Date().toISOString();
    saveGlobalConfig();

    console.log('✅ Created new assistant:', assistant.id);
    return assistant;
  } catch (error) {
    console.error('❌ Error creating/getting assistant:', error);
    throw error;
  }
}

// Function to get or create OpenAI thread for a Slack thread
async function getOrCreateOpenAIThread(slackThreadId) {
  try {
    // Check if we already have thread data
    const existingData = loadThreadData(slackThreadId);
    if (existingData && existingData.thread_id) {
      console.log('🧵 Using existing OpenAI thread:', existingData.thread_id);
      return existingData.thread_id;
    }

    // Get or create assistant
    const assistant = await getOrCreateAssistant();

    // Create new OpenAI thread
    console.log('🆕 Creating new OpenAI thread for Slack thread:', slackThreadId);
    const thread = await openai.beta.threads.create();

    // Save the thread data
    const threadData = {
      assistant_id: assistant.id,
      thread_id: thread.id,
      slack_thread_id: slackThreadId,
      created_at: new Date().toISOString(),
      last_processed_message_ts: null
    };
    saveThreadData(slackThreadId, threadData);

    // Update global statistics
    globalConfig.statistics.total_threads += 1;
    saveGlobalConfig();

    console.log('✅ Created new OpenAI thread:', thread.id);
    return thread.id;
  } catch (error) {
    console.error('❌ Error creating/getting OpenAI thread:', error);
    throw error;
  }
}

// Function to generate response using OpenAI Assistant
async function generateRhymingResponseWithAssistant(message, slackThreadId, client, channel, messageTs) {
  try {
    console.log('🎨 Generating rhyme with assistant for:', message);

    // Get or create assistant
    const assistant = await getOrCreateAssistant();

    // Get or create OpenAI thread
    const openaiThreadId = await getOrCreateOpenAIThread(slackThreadId);

    // Sync any new messages from Slack thread to OpenAI thread
    await syncSlackMessagesToOpenAI(client, channel, slackThreadId, openaiThreadId);

    // Add current message to thread
    await openai.beta.threads.messages.create(openaiThreadId, {
      role: "user",
      content: message
    });

    // Queue the assistant run to prevent concurrent runs on same thread
    const response = await queueThreadRequest(async () => {
      // Create and run the assistant
      console.log('🏃 Running assistant...');
      const run = await openai.beta.threads.runs.create(openaiThreadId, {
        assistant_id: assistant.id
      });

      let runStatus = run;
      while (runStatus.status === 'queued' || runStatus.status === 'in_progress') {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second

        try {
          runStatus = await openai.beta.threads.runs.retrieve(run.id, { thread_id: openaiThreadId });
          console.log('⏳ Assistant status:', runStatus.status);
        } catch (error) {
          console.log('⚠️ Error retrieving run status:', error);
        }
      }

      if (runStatus.status === 'completed') {
        // Get the assistant's response
        const messages = await openai.beta.threads.messages.list(openaiThreadId);
        const lastMessage = messages.data[0];

        if (lastMessage.role === 'assistant') {
          const responseText = lastMessage.content[0].text.value;
          console.log('✨ Assistant response:', responseText);

          // Update thread data with current message timestamp as last processed
          const threadData = loadThreadData(slackThreadId);
          const updatedThreadData = {
            ...(threadData || {}),
            last_processed_message_ts: messageTs
          };
          saveThreadData(slackThreadId, updatedThreadData);

          // Update message statistics
          globalConfig.statistics.total_messages += 1;
          saveGlobalConfig();

          return responseText;
        }
      } else {
        console.error('❌ Assistant run failed:', runStatus.status);
        return prompts.error_prompts.api_error;
      }

      return prompts.error_prompts.api_error;
    }, openaiThreadId);

    return response;
  } catch (error) {
    console.error('❌ Error generating response with assistant:', error);
    return prompts.error_prompts.api_error;
  }
}

// Function to summarize thread using OpenAI Assistant
async function summarizeThreadWithAssistant(slackThreadId) {
  try {
    console.log('📊 Summarizing thread with assistant:', slackThreadId);

    // Get thread data
    const threadData = loadThreadData(slackThreadId);
    if (!threadData || !threadData.thread_id) {
      return "A summary you seek, but no thread I see, start a conversation and I'll summarize with glee! 🧵";
    }

    // Get or create assistant
    const assistant = await getOrCreateAssistant();
    const openaiThreadId = threadData.thread_id;

    // Add summary request to thread
    await openai.beta.threads.messages.create(openaiThreadId, {
      role: "user",
      content: "Please provide a summary of our entire conversation thread so far. Include the main topics we discussed and key points covered."
    });

    // Queue the assistant run to prevent concurrent runs on same thread
    const summary = await queueThreadRequest(async () => {
      // Create and run the assistant
      const run = await openai.beta.threads.runs.create(openaiThreadId, {
        assistant_id: assistant.id
      });

      let runStatus = run;
      while (runStatus.status === 'queued' || runStatus.status === 'in_progress') {
        await new Promise(resolve => setTimeout(resolve, 1000));

        try {
          runStatus = await openai.beta.threads.runs.retrieve(run.id, { thread_id: openaiThreadId });
        } catch (error) {
          console.log('⚠️ Error retrieving run status:', error);
        }
      }

      if (runStatus.status === 'completed') {
        const messages = await openai.beta.threads.messages.list(openaiThreadId);
        const lastMessage = messages.data[0];

        if (lastMessage.role === 'assistant') {
          const summaryText = lastMessage.content[0].text.value;
          return summaryText;
        }
      }

      return "A summary I tried to make with care, but errors appeared from thin air! 📝";
    }, openaiThreadId);

    return summary;
  } catch (error) {
    console.error('❌ Error summarizing thread:', error);
    return "A summary I tried to make with care, but errors appeared from thin air! 📝";
  }
}

// Listen for mentions of "Leo" or "Leonard" in text (not @mentions or DMs)
app.message(/\b(leo|leonard)\b/i, async ({ message, say, client }) => {
  try {
    // Get bot user ID
    const authResult = await client.auth.test();
    const botUserId = authResult.user_id;

    // Only respond if it's NOT an actual @mention AND NOT a DM (we handle those separately)
    const isActualMention = message.text && message.text.includes(`<@${botUserId}>`);
    const isDM = message.channel_type === 'im';

    if (!isActualMention && !isDM) {
      const threadTs = message.thread_ts || message.ts;

      const mentionResponse = "Hey, did someone mention me? Use my handle @Leo to get me involved in the conversation! 🎭";

      await say({
        text: mentionResponse,
        thread_ts: threadTs
      });
    }
  } catch (error) {
    console.error('Error handling name mention:', error);
  }
});

// Listen for @mentions and DMs
app.message(async ({ message, say, client }) => {
  try {
    // Get bot user ID
    const authResult = await client.auth.test();
    const botUserId = authResult.user_id;

    // Respond to @mentions OR direct messages
    const isMentioned = message.text && message.text.includes(`<@${botUserId}>`);
    const isDM = message.channel_type === 'im';

    console.log('🔍 Mention check:', { isMentioned, isDM, messageText: message.text });

    if (isMentioned || isDM) {
      // Clean the message text (remove bot mention if it exists)
      let cleanText = message.text;
      if (isMentioned) {
        cleanText = cleanText.replace(`<@${botUserId}>`, '').trim();
      }

      // Skip if message is empty after cleaning
      if (!cleanText) {
        await say(prompts.error_prompts.empty_message);
        return;
      }

      // Use message timestamp as thread identifier (either thread_ts or message ts)
      const threadTs = message.thread_ts || message.ts;

      console.log('🧵 Thread ID:', threadTs);

      // Show typing indicator with random thinking prompt
      const randomThinking = prompts.thinking_prompts[Math.floor(Math.random() * prompts.thinking_prompts.length)];
      await client.chat.postMessage({
        channel: message.channel,
        text: randomThinking,
        thread_ts: threadTs
      });

      // Check for summary request
      if (cleanText.toLowerCase().includes('summarize') || cleanText.toLowerCase().includes('summarise') || cleanText.toLowerCase().includes('summary')) {
        const summary = await summarizeThreadWithAssistant(threadTs);
        await say({
          text: `📜 Thread Summary:\n\n${summary}`,
          thread_ts: threadTs
        });
        return;
      }

      // Generate rhyming response using OpenAI Assistant
      const rhymingResponse = await generateRhymingResponseWithAssistant(
        cleanText,
        threadTs,
        client,
        message.channel,
        message.ts
      );

      // Send the response
      await say({
        text: rhymingResponse,
        thread_ts: threadTs
      });
    }
  } catch (error) {
    console.error('Error handling message:', error);
    await say({
      text: prompts.error_prompts.general_error,
      thread_ts: message.ts
    });
  }
});

// Listen for app mentions specifically
app.event('app_mention', async ({ event, say, client }) => {
  try {
    // Get bot user ID to properly clean mentions
    const authResult = await client.auth.test();
    const botUserId = authResult.user_id;

    // Clean the message text (remove bot mention)
    let cleanText = event.text.replace(`<@${botUserId}>`, '').trim();

    if (!cleanText) {
      await say({
        text: prompts.error_prompts.empty_mention,
        channel: event.channel,
        thread_ts: event.ts
      });
      return;
    }

    // Use event timestamp as thread identifier
    const threadTs = event.thread_ts || event.ts;

    // Check for summary request
    if (cleanText.toLowerCase().includes('summarize') || cleanText.toLowerCase().includes('summarise') || cleanText.toLowerCase().includes('summary')) {
      const summary = await summarizeThreadWithAssistant(threadTs);
      await say({
        text: `📜 Thread Summary:\n\n${summary}`,
        channel: event.channel,
        thread_ts: threadTs
      });
      return;
    }

    // Generate rhyming response using OpenAI Assistant
    const rhymingResponse = await generateRhymingResponseWithAssistant(
      cleanText,
      threadTs,
      client,
      event.channel,
      event.ts
    );

    // Send the response
    await say({
      text: rhymingResponse,
      channel: event.channel,
      thread_ts: threadTs
    });
  } catch (error) {
    console.error('Error handling app mention:', error);
    await say({
      text: prompts.error_prompts.slow_response,
      channel: event.channel,
      thread_ts: event.ts
    });
  }
});

// Handle errors
app.error((error) => {
  console.error('Slack app error:', error);
});

// Start the app
(async () => {
  try {
    console.log('🚀 Starting Leonard the Rhyming Bot...');
    // Initialize OpenAI Assistant
    console.log('🤖 Initializing OpenAI Assistant...');
    await getOrCreateAssistant();

    // Update startup statistics
    globalConfig.statistics.startup_count += 1;
    globalConfig.statistics.last_startup = new Date().toISOString();
    saveGlobalConfig();

    await app.start();
    console.log('⚡️ Leonard the Rhyming Bot is running!');
    console.log(`📈 Stats: ${globalConfig.statistics.total_threads} threads, ${globalConfig.statistics.total_messages} messages, startup #${globalConfig.statistics.startup_count}`);
  } catch (error) {
    console.error('❌ Failed to start the app:', error);
  }
})();