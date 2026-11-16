# SharpTrader MCP Server

Connect **Claude, ChatGPT, DeepSeek and other MCP clients** to [SharpTrader](https://bjftradinggroup.com/product/sharptrader-forex-crypto-arbitrage/), the forex and crypto arbitrage and algorithmic trading platform by BJF Trading Group.

The MCP server is built into SharpTrader (Windows, .NET). An AI agent can read your sessions, strategies, orders, performance and logs, start and stop strategies, change settings, and now book scheduled orders inside per-account limits that the agent can read but never change.

> This repository contains the documentation and the source of the Claude Desktop extension's bridge ([`server/`](server/), see [The bridge](#the-bridge)). The MCP server itself ships inside SharpTrader; the source code of SharpTrader is not published here.

[![Watch: SharpTrader AI agents update](https://img.youtube.com/vi/pFUv7POT-bI/maxresdefault.jpg)](https://youtu.be/pFUv7POT-bI)

## Features

- **37 tools** in permission groups that you switch on one by one. Read tools only by default.
- **Monitoring**: overview, sessions, strategies, settings, instruments, open and closed orders, performance, session and strategy logs, journal, economic news.
- **Control**: start and stop strategies (one or all), trading on/off, connect and disconnect sessions.
- **Settings**: change strategy and instrument settings, the news filter and events, create and clone strategies.
- **Positions**: close all positions of a strategy at market.
- **Scheduled orders** (new, off by default): market, limit and stop orders sent now, after a delay or up to 7 days ahead, up to 50 per plan. SharpTrader sends each order on time and closes it after its holding time, even when the AI client is closed.
- **Protection**: stop loss and take profit watched by SharpTrader every second, a real broker stop loss on EASYFIX sessions, and a trailing stop (Min profit + Trailing step).
- **Flow profile**: how each account's order flow looks from the broker's side (holding times, share of buys, win rate, hours, symbols).
- **76 technical indicators** (RSI, MACD, Bollinger Bands and more) calculated on SharpTrader's own candles, M1 to MN.

## Safety model

| Guardrail | How it works |
|---|---|
| Off by default | Only read tools are on. Every write group is a separate switch. Order tools appear only after you accept a risk warning. |
| Per-account limits | For each session: Active on/off, the symbols agents may trade and each one's max volume per order, max orders and positions at once, max orders per hour, max holding time. |
| Agent cannot change limits | Limits are readable through the tools but can only be changed in SharpTrader's settings window. |
| Checked twice | Every order is checked against the limits when the plan is booked and again just before it is sent. |
| Never late, never twice | An order that cannot go out on time is retried for 5 minutes, then marked Missed. It is never sent twice. |
| Authentication | 32-byte access token on every request, HTTPS required off the local computer, IP allow-list, brute-force blocking, no browser-origin requests. |
| Audit trail | Daily call log and journal entries for every action and failure. |

![Life of a scheduled order](https://bjftradinggroup.com/wp-content/uploads/2026/11/ai-agent-non-toxic-order-lifecycle-1760x800-1.webp)

## Quick start

1. In SharpTrader open **Settings › AI agents (MCP)**, tick **Allow AI agents to connect**, choose the allowed operations and press **Apply changes**. Copy the access token.
2. **Claude Desktop**: download [SharpTrader.mcpb](https://sharptrader.s3.us-east-1.amazonaws.com/SharpTrader.mcpb) (extension 1.4.1), drag it into *Settings › Extensions*, enter the address (`http://127.0.0.1:47350/mcp` locally, or the `https://` address of your VPS), the token and, for a VPS, the `.cer` file.
3. **ChatGPT, Cursor, VS Code, Claude Code and others**: use the *Copy … config* buttons in SharpTrader, or connect to the address above with the `Authorization: Bearer <token>` header.
4. Ask: *"Show me my SharpTrader strategies and which sessions are disconnected."*

Full step-by-step guide (local and VPS layouts, certificates, firewall): **[MCP for trading](https://bjftradinggroup.com/mcp-for-trading/)**

## The bridge

[`server/index.js`](server/index.js) is the program inside `SharpTrader.mcpb`: a small Node.js bridge without dependencies that speaks MCP over stdio and forwards every message to SharpTrader's server over HTTP or HTTPS. Clients that connect to SharpTrader over HTTP directly do not need it; clients that only start local programs can use it too:

```json
{
  "mcpServers": {
    "sharptrader": {
      "command": "node",
      "args": ["C:\\sharptrader-mcp\\server\\index.js"],
      "env": { "SHARPTRADER_URL": "http://127.0.0.1:47350/mcp", "SHARPTRADER_TOKEN": "<access token>" }
    }
  }
}
```

| Variable | Meaning |
|---|---|
| `SHARPTRADER_URL` | SharpTrader's address. Default `http://127.0.0.1:47350/mcp`; another computer needs its `https://` address. |
| `SHARPTRADER_TOKEN` | The access token from *Settings › AI agents (MCP)*. |
| `SHARPTRADER_CERTIFICATE` | Only for a self-signed certificate: the path of its `.cer` file (never the `.pfx`). |

While SharpTrader cannot be reached, the bridge lists SharpTrader's tools from [`server/tools.json`](server/tools.json), generated from SharpTrader's own tool definitions, plus a `connection_status` tool that explains what is wrong. It retries every 15 seconds and, as soon as SharpTrader answers, switches to SharpTrader's own list: exactly the tools you allowed there, including the flow profile and scheduled-order tools, which come only from SharpTrader itself. The [`Dockerfile`](Dockerfile) runs the bridge for MCP catalogs; SharpTrader is not in it.

The MIT [license](LICENSE) covers the files in this repository. SharpTrader itself is commercial software.

## Example requests

- "Which sessions are disconnected and which strategies are stopped?"
- "Compare the slippage of my two LockCL2 strategies this week."
- "Show me the flow profile of my main account for the last 7 days."
- "What are RSI(14) and the 50-period SMA on H1 for EURUSD? Warn me if the candles are incomplete."
- "Give order 12 a trailing stop: start after 20 points of profit, with a 15-point step."

## Videos

- [AI agents update: scheduled orders, trailing stop, flow profile, 76 indicators](https://youtu.be/pFUv7POT-bI)
- [Control SharpTrader from Claude (VPS + Claude Desktop)](https://youtu.be/V_Kxw-lWvt0)
- [Control SharpTrader from ChatGPT](https://youtu.be/bLopKzWXWsU)
- [Manage SharpTrader by voice from your phone](https://youtu.be/YSmDX6B9j1Y)
- [Claude as a 24/7 monitoring assistant](https://youtu.be/-YRh6OmzCpM)

## Links

- Product: [SharpTrader AI Agents (MCP Server) module](https://bjftradinggroup.com/product/sharptrader-ai-agents-mcp/)
- Guide: [AI agents can now trade in SharpTrader](https://bjftradinggroup.com/ai-agent-camouflage-orders-sharptrader/)
- Agent skills: [sharptrader-non-toxic-skills](https://github.com/bjftradinggroup-inc/sharptrader-non-toxic-skills), nine free skills that teach your agent to plan non-toxic orders within your limits ([overview](https://bjftradinggroup.com/mcp-for-trading/non-toxic-skills/))
- Claude assistant article: [Claude as an AI trading assistant](https://bjftradinggroup.com/claude-ai-trading-assistant/)
- Contact: Telegram [@borisfesenko](https://t.me/borisfesenko) · Channel [t.me/bjftradinggroup](https://t.me/bjftradinggroup) · https://bjftradinggroup.com

## Risk notice

Trading with leverage carries a high risk of loss. AI agents can misunderstand a request; keep write permissions and limits as low as practical and keep your access token secret. Check that your broker's terms allow the orders you place. Software does not guarantee profit.

© BJF Trading Group Inc.
