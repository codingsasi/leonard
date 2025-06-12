# Leonard the Multi-Mode Bot 🎭

A helpful conversational Slack bot with multiple personality modes. This bot showcases the capabilities of Slack integration and AI-powered conversations using OpenAI Assistants.

## Features

- 🎭 **Multiple Modes**: Switch between Normal, Rhyme, and Leonard personality modes
- 🧵 **Thread Context**: Maintains conversation history using OpenAI threads
- 👥 **User Name Resolution**: References users by their actual names instead of IDs in summaries and conversations
- 📊 **Thread Summaries**: Provides comprehensive summaries of conversations
- 🤖 **Persistent Assistant**: Uses OpenAI Assistants for consistent personality per mode
- 💾 **Data Persistence**: Stores thread data and configuration locally
- 🔄 **Message Syncing**: Automatically syncs Slack thread history to maintain context
- ⚡ **Queue Management**: Handles concurrent requests efficiently with per-thread queuing
- 📊 **Confluence Integration**: Creates confluence page from instructions
- 📊 **Jira Integration**: Creates jira issues from instructions

## Prerequisites

- Node.js (22+)
- Slack workspace with bot permissions
- OpenAI API key
- Slack app in socket mode

## Setup

1. **Install dependencies**:
   ```bash
   npm ci
   ```

2. **Create environment file** (`.env`):
   ```env
   SLACK_BOT_TOKEN=xoxb-your-bot-token
   SLACK_SIGNING_SECRET=your-signing-secret
   SLACK_APP_TOKEN=xapp-your-app-token
   OPENAI_API_KEY=your-openai-api-key
   JIRA_EMAIL=your-jira-email
   JIRA_API_TOKEN=your-jira-token
   ```

3. **Create data directory structure**:
   ```bash
   mkdir -p data/threads
   ```

4. **Add required data files**:
   - `data/prompts.json` - Bot prompts and responses
   - `data/global-config.json` - Bot configuration and statistics

5. **Start the bot**:
   ```bash
   npm start
   ```

## Docker Deployment

### Option 1: Docker Compose (Recommended)

```bash
docker compose up --build -d
```

### Docker Environment Setup

1. **Ensure data files exist**:
   ```bash
   # Create required JSON files before deployment
   touch data/global-config.json
   ```
   Use the following as an example for global-config.json
   ```json
    {
      "assistants": {
         "normal": null,
         "rhyme": null,
         "leonard": null,
      },
      "default_mode": "normal",
      "bot_settings": {
         "name": "Leo - Multi-Mode Bot",
         "model": "gpt-4o-mini",
         "max_tokens": 10000,
         "temperature": 0.7,
         "created_at": "2025-06-11T22:23:20.627Z",
         "last_updated": "2025-06-12T04:36:13.012Z"
      },
      "confluence_settings": {
         "enabled": true,
         "base_url": "https://your-domain.atlassian.net",
         "space_key": "TL",
         "parent_page_title": "Pages created by leo",
         "page_labels": ["slack-bot", "auto-generated"]
      },
      "jira_settings": {
         "enabled": true,
         "base_url": "https://your-domain.atlassian.net",
         "project_key": "TP",
         "default_issue_type": "Task",
         "default_priority": "Medium",
         "default_components": ["slack-bot"],
         "default_labels": ["slack-bot", "auto-generated"],
         "default_assignee": ""
      },
      "statistics": {
         "total_threads": 18,
         "total_messages": 24,
         "startup_count": 15,
         "mode_switches": 3,
         "confluence_pages_created": 0,
         "jira_issues_created": 0,
         "last_startup": "2025-06-12T16:34:15.108Z",
         "last_updated": "2025-06-12T16:34:15.108Z"
      },
      "metadata": {
         "version": "3.0",
         "description": "Global configuration for Leo Multi-Mode Slack Bot",
         "thread_storage_format": "individual_files",
         "created": "2025-01-12T18:15:00.000Z",
         "modes_available": [
            "normal",
            "rhyme",
            "leonard"
         ]
      }
   }

   ```

### Production Deployment Tips

- **Environment Variables**: Use Docker secrets or a secure environment file
- **Data Backup**: Regularly backup the `data/` directory
- **Monitoring**: Use `docker logs leonard-bot -tf` to monitor bot activity
- **Updates**: Rebuild and redeploy when updating the bot code
- **Health Checks**: Consider adding health check endpoints

## Usage

### Basic Interaction
- **Mention the bot**: `@leo Hello there!`
- **Direct messages**: Send a DM to the bot
- **Name mentions**: Say "Leo" or "Leonard" in a channel (bot will suggest using @mention)

### Mode Switching
- `@leo switch to rhyme mode` - Switch to rhyming responses
- `@leo normal mode` - Switch to normal conversation mode
- `@leo leonard mode` - Switch to Leonard personality mode

### Thread Management
- **Request summary**: `@leo summarize this thread`
- **Get help**: `@leo help` or mention with questions

### User Name Resolution
The bot automatically resolves Slack user IDs to actual display names when:
- Syncing message history to maintain context
- Generating thread summaries
- Referencing users in conversations

This ensures summaries show "John Smith asked about..." instead of "U06MKN6SS5B asked about..."

## Data Storage

- Thread data stored in `data/threads/sl-{thread-id}.json`
- Global configuration in `data/global-config.json`
- Prompts and responses in `data/prompts.json`
- Per-thread mode tracking and message timestamps

## Architecture

- **Per-thread queuing**: Prevents concurrent OpenAI Assistant runs on the same thread
- **Mode persistence**: Each thread remembers its current mode
- **Message syncing**: Automatically syncs Slack history to OpenAI threads for context
- **Assistant management**: Creates and manages separate OpenAI Assistants for each mode

## Author

**Abhai Sasidharan** ([@codingsasi](https://github.com/codingsasi))

🔗 **Repository**: https://github.com/codingsasi/leonard

I built this bot as a fun project to showcase how simple it is to make slackbots + chat GPT quite useful. I built this bot to learn more about slack API and it's capabilities. Hopeing I can build something useful. - Abhai

---

*Leonard the Multi-Mode Bot - Bringing personality and intelligence to your Slack workspace! 🎭*