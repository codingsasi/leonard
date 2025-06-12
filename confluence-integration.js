const fs = require('fs');
const path = require('path');

// Function to parse Confluence page creation commands
function parseConfluenceCommand(text) {
  const lowerText = text.toLowerCase().trim();

  // Pattern 1: Smart generation - "create confluence page to document..."
  const smartPattern = /(?:please\s+)?create\s+(?:a\s+)?confluence\s+(?:page|doc|document)\s+(?:to\s+)?(.+)/i;
  const smartMatch = text.match(smartPattern);
  if (smartMatch) {
    return {
      isConfluenceCommand: true,
      isSmartGeneration: true,
      instructions: smartMatch[1].trim()
    };
  }

  // Pattern 2: "create confluence page: Title"
  const pattern1 = /(?:create\s+)?confluence\s+(?:page|doc)?\s*:\s*(.+)/i;
  const match1 = text.match(pattern1);
  if (match1) {
    return {
      isConfluenceCommand: true,
      title: match1[1].trim(),
      content: `Created from Slack by request`
    };
  }

  // Pattern 3: "confluence: Title | Content"
  const pattern2 = /confluence\s*:\s*([^|]+)(?:\|\s*(.+))?/i;
  const match2 = text.match(pattern2);
  if (match2) {
    return {
      isConfluenceCommand: true,
      title: match2[1].trim(),
      content: match2[2] ? match2[2].trim() : `Created from Slack by request`
    };
  }

  // Pattern 4: Simple "confluence help"
  if (lowerText.includes('confluence help') || lowerText === 'confluence') {
    return {
      isConfluenceCommand: true,
      isHelpRequest: true
    };
  }

  return {
    isConfluenceCommand: false
  };
}

// Function to create Confluence page
async function createConfluencePage(title, content, creatorName = 'Slack Bot', globalConfig, saveGlobalConfig) {
  try {
    console.log('📄 Creating Confluence page:', title);

    if (!globalConfig.confluence_settings.enabled) {
      console.log('⚠️ Confluence integration is disabled');
      return { success: false, error: 'Confluence integration is disabled' };
    }

    // Check for required environment variables (same as JIRA)
    if (!process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
      console.log('⚠️ Confluence credentials not configured');
      return {
        success: false,
        error: 'Confluence credentials not configured. Please set JIRA_EMAIL and JIRA_API_TOKEN environment variables.'
      };
    }

    const confluenceConfig = globalConfig.confluence_settings;
    const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

    // First, try to find the parent page (optional)
    let parentPageId = null;
    if (confluenceConfig.parent_page_title) {
      try {
        const searchResponse = await fetch(`${confluenceConfig.base_url}/wiki/rest/api/content?title=${encodeURIComponent(confluenceConfig.parent_page_title)}&spaceKey=${confluenceConfig.space_key}&expand=version`, {
          headers: {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json'
          }
        });

        if (searchResponse.ok) {
          const searchResult = await searchResponse.json();
          if (searchResult.results && searchResult.results.length > 0) {
            parentPageId = searchResult.results[0].id;
            console.log('📁 Found parent page:', parentPageId);
          }
        }
      } catch (error) {
        console.log('⚠️ Could not find parent page, creating at space root');
      }
    }

    // Create the page content with better formatting
    const pageContent = `
        <p><strong>Created from Slack</strong></p>
        <p>${content}</p>
        <hr/>
        <p><em>Created by: ${creatorName} via Slack Bot</em></p>
        <p><em>Created on: ${new Date().toLocaleString()}</em></p>
      `.trim();

    const pageData = {
      type: 'page',
      title: title,
      space: {
        key: confluenceConfig.space_key
      },
      body: {
        storage: {
          value: pageContent,
          representation: 'storage'
        }
      }
    };

    // Add parent page if found
    if (parentPageId) {
      pageData.ancestors = [{ id: parentPageId }];
    }

    const response = await fetch(`${confluenceConfig.base_url}/wiki/rest/api/content`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(pageData)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ Confluence API error:', response.status, errorText);
      return {
        success: false,
        error: `Confluence API error: ${response.status} - ${errorText}`
      };
    }

    const result = await response.json();
    console.log('✅ Confluence page created:', result.id);

    // Add labels if configured
    if (confluenceConfig.page_labels && confluenceConfig.page_labels.length > 0) {
      try {
        const labels = confluenceConfig.page_labels.map(label => ({ name: label }));
        await fetch(`${confluenceConfig.base_url}/wiki/rest/api/content/${result.id}/label`, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(labels)
        });
        console.log('🏷️ Added labels to page');
      } catch (error) {
        console.log('⚠️ Could not add labels to page');
      }
    }

    // Update statistics
    globalConfig.statistics.confluence_pages_created += 1;
    saveGlobalConfig();

    return {
      success: true,
      id: result.id,
      title: result.title,
      url: `${confluenceConfig.base_url}/wiki${result._links.webui}`
    };

  } catch (error) {
    console.error('❌ Error creating Confluence page:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Function to generate Confluence page content from thread conversation
async function generateConfluenceContentFromThread(instructions, openaiThreadId, assistantId, openai, queueThreadRequest) {
  try {
    console.log('🤖 Generating Confluence content from thread conversation...');

    // Create a detailed prompt for content generation
    const prompt = `
Based on our entire conversation thread, please create a comprehensive Confluence page with the following requirements:

**User Instructions**: ${instructions}

Please provide your response in the following JSON format:
{
  "title": "A clear, descriptive title for the page",
  "content": "Well-organized HTML content for the Confluence page"
}

**Content Guidelines**:
- Use proper HTML formatting with headings (h2, h3), paragraphs (p), lists (ul, ol), etc.
- Include sections like: Summary, Key Findings, Discussion Points, Action Items, Next Steps (as appropriate)
- Make it professional and well-structured
- Include specific details and quotes from our conversation where relevant
- If action items are requested, create a clear actionable list
- Use <strong> for emphasis and proper HTML structure

**Example Structure**:
<h2>Summary</h2>
<p>Brief overview of the discussion...</p>

<h2>Key Findings</h2>
<ul>
<li>Finding 1...</li>
<li>Finding 2...</li>
</ul>

<h2>Action Items</h2>
<ol>
<li><strong>Responsible Party:</strong> Action description with deadline</li>
</ol>

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
                title: parsed.title || 'Thread Documentation',
                content: parsed.content || responseText
              };
            }
          } catch (parseError) {
            console.log('⚠️ Could not parse JSON, using raw response');
          }

          // Fallback: use raw response and generate a simple title
          return {
            success: true,
            title: 'Thread Documentation',
            content: `<h2>Generated Content</h2><div>${responseText}</div>`
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
    console.error('❌ Error generating Confluence content:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  parseConfluenceCommand,
  createConfluencePage,
  generateConfluenceContentFromThread
};