const fs = require('fs');
const path = require('path');

// Function to parse JIRA issue creation commands
function parseJiraCommand(text) {
  const lowerText = text.toLowerCase().trim();

  // Pattern 1: Smart generation - "create jira issue to track..."
  const smartPattern = /(?:please\s+)?create\s+(?:a\s+)?jira\s+(?:issue|ticket)\s+(?:to\s+)?(.+)/i;
  const smartMatch = text.match(smartPattern);
  if (smartMatch) {
    return {
      isJiraCommand: true,
      isSmartGeneration: true,
      instructions: smartMatch[1].trim()
    };
  }

  // Pattern 2: "create jira issue: Title"
  const pattern1 = /(?:create\s+)?jira\s+(?:issue|ticket)?\s*:\s*(.+)/i;
  const match1 = text.match(pattern1);
  if (match1) {
    return {
      isJiraCommand: true,
      title: match1[1].trim(),
      description: `Created from Slack by request`
    };
  }

  // Pattern 3: "jira: Title | Description"
  const pattern2 = /jira\s*:\s*([^|]+)(?:\|\s*(.+))?/i;
  const match2 = text.match(pattern2);
  if (match2) {
    return {
      isJiraCommand: true,
      title: match2[1].trim(),
      description: match2[2] ? match2[2].trim() : `Created from Slack by request`
    };
  }

  // Pattern 4: Simple "jira help"
  if (lowerText.includes('jira help') || lowerText === 'jira') {
    return {
      isJiraCommand: true,
      isHelpRequest: true
    };
  }

  return {
    isJiraCommand: false
  };
}

// Function to create JIRA issue
async function createJiraIssue(title, description, creatorName = 'Slack Bot', globalConfig, saveGlobalConfig) {
  try {
    console.log('🎫 Creating JIRA issue:', title);

    if (!globalConfig.jira_settings.enabled) {
      console.log('⚠️ JIRA integration is disabled');
      return { success: false, error: 'JIRA integration is disabled' };
    }

    // Check for required environment variables
    if (!process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
      console.log('⚠️ JIRA credentials not configured');
      return {
        success: false,
        error: 'JIRA credentials not configured. Please set JIRA_EMAIL and JIRA_API_TOKEN environment variables.'
      };
    }

    const jiraConfig = globalConfig.jira_settings;
    const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

    // Format the description with metadata
    const issueDescription = `
*Created from Slack*

${description}

---
_Created by: ${creatorName} via Slack Bot_
_Created on: ${new Date().toLocaleString()}_
    `.trim();

    const issueData = {
      fields: {
        project: {
          key: jiraConfig.project_key
        },
        summary: title,
        description: issueDescription,
        issuetype: {
          name: jiraConfig.default_issue_type || 'Task'
        }
      }
    };

    // Add assignee if configured
    if (jiraConfig.default_assignee) {
      issueData.fields.assignee = {
        name: jiraConfig.default_assignee
      };
    }

    // Add priority if configured
    if (jiraConfig.default_priority) {
      issueData.fields.priority = {
        name: jiraConfig.default_priority
      };
    }

    // Add components if configured
    if (jiraConfig.default_components && jiraConfig.default_components.length > 0) {
      issueData.fields.components = jiraConfig.default_components.map(component => ({
        name: component
      }));
    }

    // Add labels if configured
    if (jiraConfig.default_labels && jiraConfig.default_labels.length > 0) {
      issueData.fields.labels = jiraConfig.default_labels;
    }

    const response = await fetch(`${jiraConfig.base_url}/rest/api/2/issue`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(issueData)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ JIRA API error:', response.status, errorText);
      return {
        success: false,
        error: `JIRA API error: ${response.status} - ${errorText}`
      };
    }

    const result = await response.json();
    console.log('✅ JIRA issue created:', result.key);

    // Update statistics
    globalConfig.statistics.jira_issues_created += 1;
    saveGlobalConfig();

    return {
      success: true,
      key: result.key,
      id: result.id,
      title: title,
      url: `${jiraConfig.base_url}/browse/${result.key}`
    };

  } catch (error) {
    console.error('❌ Error creating JIRA issue:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Function to generate JIRA issue content from thread conversation
async function generateJiraContentFromThread(instructions, openaiThreadId, assistantId, openai, queueThreadRequest) {
  try {
    console.log('🤖 Generating JIRA issue content from thread conversation...');

    // Create a detailed prompt for content generation
    const prompt = `
Based on our entire conversation thread, please create a comprehensive JIRA issue with the following requirements:

**User Instructions**: ${instructions}

Please provide your response in the following JSON format:
{
  "title": "A clear, concise title for the JIRA issue",
  "description": "Well-organized description for the JIRA issue using JIRA markup"
}

**Description Guidelines**:
- Use JIRA markup formatting: *bold*, _italic_, {{monospace}}, etc.
- Include sections like: h2. Background, h2. Acceptance Criteria, h2. Steps to Reproduce, h2. Additional Notes (as appropriate)
- Make it professional and well-structured
- Include specific details and quotes from our conversation where relevant
- If this is a bug, include reproduction steps
- If this is a feature request, include clear acceptance criteria
- Use bullet points (-) for lists and numbered lists (1.) where appropriate

**Example Structure for Bug**:
h2. Background
Brief description of the issue...

h2. Steps to Reproduce
# Step 1
# Step 2
# Step 3

h2. Expected Behavior
What should happen...

h2. Actual Behavior
What actually happens...

**Example Structure for Feature/Task**:
h2. Description
Brief overview of what needs to be done...

h2. Acceptance Criteria
- Criteria 1
- Criteria 2
- Criteria 3

h2. Additional Notes
Any relevant context from our discussion...

Please analyze our conversation and create content that matches the user's specific instructions.
    `;

    // Add the generation request to the OpenAI thread
    await openai.beta.threads.messages.create(openaiThreadId, {
      role: "user",
      content: prompt
    });

    // Queue the request and get the response
    const response = await queueThreadRequest(async () => {
      // Create and run the assistant
      const run = await openai.beta.threads.runs.create(openaiThreadId, {
        assistant_id: assistantId
      });

      let runStatus = run;
      let attempts = 0;
      const maxAttempts = 30; // 30 seconds timeout

      while ((runStatus.status === 'queued' || runStatus.status === 'in_progress') && attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        attempts++;

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
          const responseText = lastMessage.content[0].text.value;

          try {
            // Try to parse JSON response
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              const parsed = JSON.parse(jsonMatch[0]);
              return {
                success: true,
                title: parsed.title || 'Thread Issue',
                description: parsed.description || responseText
              };
            }
          } catch (parseError) {
            console.log('⚠️ Could not parse JSON, using raw response');
          }

          // Fallback: use raw response and generate a simple title
          return {
            success: true,
            title: 'Thread Issue',
            description: `h2. Generated Content\n\n${responseText}`
          };
        }
      }

      console.error('❌ Assistant run failed or timed out:', runStatus.status);
      return {
        success: false,
        error: `Content generation failed: ${runStatus.status}`
      };
    }, openaiThreadId);

    return response;

  } catch (error) {
    console.error('❌ Error generating JIRA content:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  parseJiraCommand,
  createJiraIssue,
  generateJiraContentFromThread
};