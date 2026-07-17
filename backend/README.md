# Aeldorado API — The Legendary Intelligence

Professional Multi-Agent Orchestration Platform by Solanacy Technologies.

## 🚀 Overview

Aeldorado is a high-performance, secure, and agentic AI platform designed for professional business intelligence. It features a CEO-led orchestrator that intelligently routes requests to specialized agents (CFO, Sales, Marketing, etc.) and synthesizes their outputs into actionable results.

## 🛠 Architecture

- **CEO Orchestrator**: The central brain that analyzes intent and routes tasks.
- **Multi-Agent System**: Specialized agents for Finance, Sales, Research, etc.
- **E2E Key Vault**: User API keys are encrypted client-side and only decrypted in-memory during execution.
- **Unified AI Client**: Seamlessly switch between Gemini, OpenAI, and Anthropic.
- **Robust Middleware**: Integrated rate-limiting, usage tracking, and security headers.

## 🔒 Security

- **Client-Side Encryption**: Your API keys never touch our servers in plaintext.
- **Anti-Abuse System**: Built-in IP detection and rate-limiting.
- **Privacy First**: We do not persist your sensitive API keys.

## 📦 Getting Started

### Prerequisites

- Node.js >= 20.0.0
- Firebase Service Account (for Firestore and Auth)

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

### Production

```bash
npm start
```

## 📄 API Endpoints

- `POST /v1/chat`: Multi-agent chat orchestration.
- `GET /v1/usage`: Retrieve real-time usage stats and limits.

---
© 2026 Solanacy Technologies. All rights reserved.
