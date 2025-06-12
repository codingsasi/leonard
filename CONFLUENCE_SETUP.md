# Confluence Integration Setup

This bot now supports creating Confluence pages directly from Slack! Here's how to set it up:

## Environment Variables

Add these to your `.env` file:

```bash
# Confluence Configuration (Optional - for page creation)
JIRA_EMAIL=your-email@domain.com
JIRA_API_TOKEN=your-atlassian-api-token-here
```

## Getting Your Atlassian API Token

1. Go to [Atlassian Account Settings](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click "Create API token"
3. Give it a label (e.g., "Slack Bot Integration")
4. Copy the generated token

## Configuring Confluence Settings

Edit `data/global-config.json` and update the `confluence_settings` section:

```json
{
  "confluence_settings": {
    "enabled": true,
    "base_url": "https://your-domain.atlassian.net",
    "space_key": "YOUR_SPACE_KEY",
    "parent_page_title": "Bot Created Pages",
    "page_labels": ["slack-bot", "auto-generated"]
  }
}
```

Replace:
- `your-domain` with your actual Atlassian domain
- `YOUR_SPACE_KEY` with your Confluence space key (e.g., "TEMP", "DEV", "PROJ")

## Usage Commands

Once configured, you can create Confluence pages using these commands:

### Smart Generation (🤖 AI analyzes thread):
Leo can intelligently analyze your thread conversation and automatically generate organized documentation:

#### In Slack Channels (mention the bot):
```
@leo create confluence page to document the findings in this thread
@leo create confluence page to summarize our discussion with action items
@leo create confluence page to capture key decisions and next steps
@leo create confluence page to document meeting notes with organized sections
```

#### In Direct Messages:
```
create confluence page to document the findings in this thread
create confluence page to summarize our discussion with action items
```

### Manual Creation (you provide content):
For quick pages with specific content:

#### In Slack Channels (mention the bot):
```
@leo create confluence page: Meeting Notes
@leo confluence: Meeting Notes | Discussion about new features
@leo confluence help
```

#### In Direct Messages:
```
create confluence page: Meeting Notes
confluence: Meeting Notes | Discussion about new features
confluence help
```

## Features

### 🤖 Smart Generation (NEW!)
- ✅ **AI-powered content generation** from thread conversations
- ✅ **Automatic title creation** based on discussion context
- ✅ **Organized documentation** with sections like Summary, Key Findings, Action Items
- ✅ **Professional formatting** with proper HTML structure
- ✅ **Context-aware analysis** of the entire thread history

### 📄 Page Creation
- ✅ Creates pages with proper HTML formatting
- ✅ Includes creator name from Slack
- ✅ Supports both smart and manual content creation
- ✅ Returns clickable page links
- ✅ Automatically adds labels (`slack-bot`, `auto-generated`)
- ✅ Can nest under parent pages
- ✅ Tracks statistics
- ✅ Graceful error handling

## Demo Mode

For demo purposes, you can showcase both capabilities:

### Smart Generation Demo:
1. Have a conversation in a Slack thread (discuss a project, meeting, decisions)
2. Use: `@leo create confluence page to document our discussion with action items`
3. Watch Leo analyze the conversation and create organized documentation
4. Show the generated page with professional formatting

### Manual Creation Demo:
1. Set up a test Confluence space
2. Use space key "TEMP" (or create your own)
3. Create pages with: `@leo confluence: Demo Page | This is a test page`
4. Pages will be nicely formatted with creator info
5. Disable by setting `"enabled": false` in config

**Pro Tip**: The smart generation feature is perfect for demonstrating AI-powered workflow automation!

## Required Confluence API Scopes

For this integration to work, your Atlassian API token needs these scopes:

### **Essential Scopes:**
- **`write:page:confluence`** - Create and update pages
- **`read:space:confluence`** - View space details (to verify space exists)
- **`read:content:confluence`** - View content (to find parent pages)
- **`write:label:confluence`** - Add labels to created pages
- **`read:user:confluence`** - View user details (for attribution)

### **Optional Scopes (for enhanced features):**
- **`read:space.permission:confluence`** - Check space permissions
- **`write:content.property:confluence`** - Add custom properties to pages
- **`read:template:confluence`** - Use page templates (future feature)

### **Classic Scopes Alternative:**
If using classic scopes instead of granular:
- **`write:confluence-content`** - Create pages, blogs, comments
- **`read:confluence-content.summary`** - Read content summaries
- **`read:confluence-space.summary`** - Read space information
- **`read:confluence-user`** - View user information

## Troubleshooting

- **"Confluence integration is disabled"**: Check `enabled: true` in config
- **"Confluence credentials not configured"**: Set JIRA_EMAIL and JIRA_API_TOKEN
- **"Confluence API error"**: Check your domain, space key, and API token
- **Permission errors**: Ensure your user has permission to create pages in the space
- **"Parent page not found"**: The parent page title may not exist - pages will be created at space root