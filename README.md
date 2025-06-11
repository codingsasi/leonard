# Leonard the Rhyming Bot 🎭

A Slack bot that responds to messages with creative rhyming responses using OpenAI's Assistant API. Leonard maintains conversation context across threads and can provide rhyming summaries of discussions.

## Features

- 🎵 **Rhyming Responses**: Generates creative, rhyming replies to messages
- 🧵 **Thread Context**: Maintains conversation history using OpenAI threads
- 📊 **Thread Summaries**: Provides rhyming summaries of conversations
- 🤖 **Persistent Assistant**: Uses OpenAI Assistants for consistent personality
- 💾 **Data Persistence**: Stores thread data and configuration locally

## Prerequisites

- Node.js (22)
- Slack workspace with bot permissions
- OpenAI API key
- Slack app in socket mode.

## Setup

2. **Create environment file** (`.env`):
   ```env
   SLACK_BOT_TOKEN=xoxb-your-bot-token
   SLACK_SIGNING_SECRET=your-signing-secret
   SLACK_APP_TOKEN=xapp-your-app-token
   OPENAI_API_KEY=your-openai-api-key
   ```

3. **Create data directory structure**:
   ```bash
   mkdir -p data/threads
   ```

4. **Add required data files**:
   - `data/prompts.json` - Bot prompts and responses
   - `data/global-config.json` - Bot configuration and statistics

## Usage

- **Mention the bot**: `@leo Hello there!`
- **Request summary**: Include "summary" or "summarize" in your message


The bot will start in Socket Mode and begin listening for mentions and direct messages.

## Data Storage

- Thread data stored in `data/threads/sl-{thread-id}.json`
- Global configuration in `data/global-config.json`
- Prompts and responses in `data/prompts.json`