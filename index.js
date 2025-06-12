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

    // Check if this is a DM (channel starts with 'D') vs a channel thread
    const isDM = channel.startsWith('D');
    let result;

    if (isDM) {
      // For DMs, use conversations.history to get the conversation history
      result = await client.conversations.history({
        channel: channel,
        inclusive: true,
        oldest: sinceTs || undefined,
        limit: 100  // Limit to recent messages
      });
    } else {
      // For channel threads, use conversations.replies
      result = await client.conversations.replies({
        channel: channel,
        ts: threadTs,
        inclusive: true,
        oldest: sinceTs || undefined
      });
    }

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

    console.log(`📨 Found ${filteredMessages.length} new messages to sync (${isDM ? 'DM' : 'thread'})`);
    return filteredMessages;
  } catch (error) {
    console.error('❌ Error fetching Slack thread messages:', error);
    return [];
  }
}

// Function to get user display name from Slack user ID
async function getUserDisplayName(client, userId) {
  try {
    const result = await client.users.info({ user: userId });
    if (result.ok && result.user) {
      // Try display_name first, then real_name, then name as fallback
      return result.user.profile?.display_name ||
             result.user.profile?.real_name ||
             result.user.name ||
             userId; // fallback to ID if nothing else works
    }
    return userId; // fallback to ID if API call fails
  } catch (error) {
    console.error('❌ Error fetching user info for:', userId, error);
    return userId; // fallback to ID on error
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
      const contextMessage = `[${await getUserDisplayName(client, message.user)}]: ${message.text}`;

      await openai.beta.threads.messages.create(openaiThreadId, {
        role: "user",
        content: `Context from Slack thread: ${contextMessage}`
      });

      latestTs = message.ts;
      console.log(`📝 Synced message from ${await getUserDisplayName(client, message.user)}`);
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



// Function to get or create OpenAI Assistant for a specific mode
async function getOrCreateAssistant(mode = 'normal') {
  try {
    // Validate mode
    if (!prompts.modes[mode]) {
      console.log(`⚠️ Invalid mode '${mode}', using default mode '${prompts.default_mode}'`);
      mode = prompts.default_mode;
    }

    // If we already have an assistant ID for this mode, try to retrieve it
    if (globalConfig.assistants[mode]) {
      try {
        const assistant = await openai.beta.assistants.retrieve(globalConfig.assistants[mode]);
        console.log(`🤖 Using existing ${mode} assistant:`, assistant.id);
        return assistant;
      } catch (error) {
        console.log(`⚠️ Existing ${mode} assistant not found, creating new one`);
        globalConfig.assistants[mode] = null;
      }
    }

    // Create new assistant for this mode
    console.log(`🚀 Creating new OpenAI Assistant for ${mode} mode...`);
    const assistant = await openai.beta.assistants.create({
      name: `${globalConfig.bot_settings.name} - ${prompts.modes[mode].name}`,
      instructions: prompts.modes[mode].system_prompt,
      model: globalConfig.bot_settings.model,
      tools: [],
      response_format: { type: "text" }
    });

    // Save the assistant ID to global config
    globalConfig.assistants[mode] = assistant.id;
    globalConfig.bot_settings.last_updated = new Date().toISOString();
    saveGlobalConfig();

    console.log(`✅ Created new ${mode} assistant:`, assistant.id);
    return assistant;
  } catch (error) {
    console.error(`❌ Error creating/getting ${mode} assistant:`, error);
    throw error;
  }
}

// Function to get current mode for a thread
function getThreadMode(slackThreadId) {
  const threadData = loadThreadData(slackThreadId);
  return threadData?.current_mode || prompts.default_mode;
}

// Function to set mode for a thread
function setThreadMode(slackThreadId, mode) {
  const threadData = loadThreadData(slackThreadId) || {};
  threadData.current_mode = mode;
  threadData.last_mode_change = new Date().toISOString();
  saveThreadData(slackThreadId, threadData);

  // Update global statistics
  globalConfig.statistics.mode_switches += 1;
  saveGlobalConfig();

  console.log(`🔄 Set thread ${slackThreadId} to ${mode} mode`);
}

// Function to parse mode switch commands
function parseModeCommand(text) {
  const lowerText = text.toLowerCase().trim();

  // Look for mode switch patterns
  const patterns = [
    /(?:turn on|switch to|change to|use|set|enable)\s+(normal|rhyme|leonard)\s*mode/i,
    /(?:mode|switch)\s+(normal|rhyme|leonard)/i,
    /(normal|rhyme|leonard)\s*mode/i
  ];

  for (const pattern of patterns) {
    const match = lowerText.match(pattern);
    if (match) {
      return match[1].toLowerCase();
    }
  }

  return null;
}

// Function to get or create OpenAI thread for a Slack thread with mode support
async function getOrCreateOpenAIThread(slackThreadId, mode = 'normal') {
  try {
    // Check if we already have thread data
    const existingData = loadThreadData(slackThreadId);
    if (existingData && existingData.thread_id) {
      console.log('🧵 Using existing OpenAI thread:', existingData.thread_id);
      return existingData.thread_id;
    }

    // Get or create assistant for the current mode
    const assistant = await getOrCreateAssistant(mode);

    // Create new OpenAI thread
    console.log('🆕 Creating new OpenAI thread for Slack thread:', slackThreadId);
    const thread = await openai.beta.threads.create();

    // Save the thread data
    const threadData = {
      assistant_id: assistant.id,
      thread_id: thread.id,
      slack_thread_id: slackThreadId,
      current_mode: mode,
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

// Function to generate response using OpenAI Assistant with mode support
async function generateResponseWithAssistant(message, slackThreadId, client, channel, messageTs) {
  try {
    const currentMode = getThreadMode(slackThreadId);
    console.log(`🎨 Generating response in ${currentMode} mode for:`, message);

    // Get or create assistant for current mode
    const assistant = await getOrCreateAssistant(currentMode);

    // Get or create OpenAI thread
    const openaiThreadId = await getOrCreateOpenAIThread(slackThreadId, currentMode);

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
      console.log(`🏃 Running ${currentMode} assistant...`);
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
          console.log(`✨ ${currentMode} assistant response:`, responseText);

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
async function summarizeThreadWithAssistant(slackThreadId, client, channel) {
  try {
    console.log('📊 Summarizing thread with assistant:', slackThreadId);

    // Get current mode
    const currentMode = getThreadMode(slackThreadId);

    // Get or create assistant for current mode
    const assistant = await getOrCreateAssistant(currentMode);

    // Get or create OpenAI thread
    const openaiThreadId = await getOrCreateOpenAIThread(slackThreadId, currentMode);

    // Sync any new messages from Slack thread to OpenAI thread before summarizing
    await syncSlackMessagesToOpenAI(client, channel, slackThreadId, openaiThreadId);

    // Add summary request to thread
    await openai.beta.threads.messages.create(openaiThreadId, {
      role: "user",
      content: "Please provide a summary of our entire conversation thread so far. Include the main topics we discussed and key points covered. Keep it organized using bullet points, paragraphs, and other formatting as needed."
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

      return "I had trouble creating that summary. Please try again! 📝";
    }, openaiThreadId);

    return summary;
  } catch (error) {
    console.error('❌ Error summarizing thread:', error);
    return "I had trouble creating that summary. Please try again! 📝";
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

// Dms only
app.message(async ({ message, say, client }) => {
  try {
    // Get bot user ID
    const authResult = await client.auth.test();
    const botUserId = authResult.user_id;

    // Respond to DMs only
    const isDM = message.channel_type === 'im';

    if (isDM) {
      const messageText = message.text || '';

      // Use message timestamp as thread identifier (either thread_ts or message ts)
      const threadTs = message.thread_ts || message.ts;

      console.log('🧵 Thread ID:', threadTs);

      // Check for mode switch command
      const newMode = parseModeCommand(messageText);
      if (newMode) {
        setThreadMode(threadTs, newMode);
        await say({
          text: prompts.mode_switch_responses[newMode],
          thread_ts: threadTs
        });
        return;
      }

      // Show typing indicator with random thinking prompt
      const randomThinking = prompts.thinking_prompts[Math.floor(Math.random() * prompts.thinking_prompts.length)];
      await client.chat.postMessage({
        channel: message.channel,
        text: randomThinking,
        thread_ts: threadTs
      });

      // Generate response using OpenAI Assistant
      const response = await generateResponseWithAssistant(
        messageText,
        threadTs,
        client,
        message.channel,
        message.ts
      );

      // Send the response
      await say({
        text: response,
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

    // Check for mode switch command
    const newMode = parseModeCommand(cleanText);
    if (newMode) {
      setThreadMode(threadTs, newMode);
      await say({
        text: prompts.mode_switch_responses[newMode],
        channel: event.channel,
        thread_ts: threadTs
      });
      return;
    }

        // Check for summary request
    if (cleanText.toLowerCase().includes('summarize') || cleanText.toLowerCase().includes('summarise') || cleanText.toLowerCase().includes('summary')) {
      const summary = await summarizeThreadWithAssistant(threadTs, client, event.channel);
      await say({
        text: `📜 Thread Summary:\n\n${summary}`,
        channel: event.channel,
        thread_ts: threadTs
      });
      return;
    }

    // Show typing indicator with random thinking prompt
    const currentMode = getThreadMode(threadTs);
    const randomThinking = prompts.thinking_prompts[Math.floor(Math.random() * prompts.thinking_prompts.length)];
    await client.chat.postMessage({
      channel: event.channel,
      text: `${randomThinking} (${prompts.modes[currentMode].name})`,
      thread_ts: threadTs
    });

    // Generate response using OpenAI Assistant
    const response = await generateResponseWithAssistant(
      cleanText,
      threadTs,
      client,
      event.channel,
      event.ts
    );

    // Send the response
    await say({
      text: response,
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
    console.log('🚀 Starting Leo Multi-Mode Bot...');

    // Initialize OpenAI Assistants for all modes
    console.log('🤖 Initializing OpenAI Assistants for all modes...');
    const availableModes = Object.keys(prompts.modes);
    for (const mode of availableModes) {
      try {
        await getOrCreateAssistant(mode);
        console.log(`✅ ${mode} mode assistant ready`);
      } catch (error) {
        console.error(`❌ Failed to initialize ${mode} assistant:`, error);
      }
    }

    // Update startup statistics
    globalConfig.statistics.startup_count += 1;
    globalConfig.statistics.last_startup = new Date().toISOString();
    saveGlobalConfig();

    await app.start();
    console.log('⚡️ Leo Multi-Mode Bot is running!');
    console.log(`🎭 Available modes: ${availableModes.join(', ')}`);
    console.log(`📈 Stats: ${globalConfig.statistics.total_threads} threads, ${globalConfig.statistics.total_messages} messages, ${globalConfig.statistics.mode_switches} mode switches, startup #${globalConfig.statistics.startup_count}`);
  } catch (error) {
    console.error('❌ Failed to start the app:', error);
  }
})();