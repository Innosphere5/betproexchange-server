# BetPro Exchange — Backend Engine & Real-Time Server

[![Node.js](https://img.shields.io/badge/Node.js-24.x-green?style=for-the-badge&logo=node.js)](https://nodejs.org/)
[![Express.js](https://img.shields.io/badge/Express.js-5.x-black?style=for-the-badge&logo=express)](https://expressjs.com/)
[![MongoDB](https://img.shields.io/badge/MongoDB-Mongoose-47A248?style=for-the-badge&logo=mongodb)](https://www.mongodb.com/)
[![Socket.io](https://img.shields.io/badge/Socket.io-4.8.3-010101?style=for-the-badge&logo=socketdotio)](https://socket.io/)
[![OddsPapi v5](https://img.shields.io/badge/OddsPapi-v5_REST_%26_WS-orange?style=for-the-badge)]()
[![Tests](https://img.shields.io/badge/Tests-Passing_34%2F34-brightgreen?style=for-the-badge)]()

High-throughput, real-time sports betting exchange backend engine. Built with **Node.js**, **Express**, **Socket.io**, and **MongoDB**. Integrates directly with official **OddsPapi v5** and **Sportmonks** sports data APIs to deliver streaming live odds, ball-by-ball score feeds, automated market settlements, and multi-tier shareholder profit/loss hierarchy distribution.

---

## ⚡ Core Architecture

```
                               ┌─────────────────────────────┐
                               │       OddsPapi v5 API       │
                               │  (REST Fixtures & WS Odds)  │
                               └──────────────┬──────────────┘
                                              │
                                              ▼
┌─────────────────────────┐      ┌─────────────────────────────┐      ┌─────────────────────────┐
│     Sportmonks API      │─────▶│  betproexchange-server      │◀────▶│     MongoDB Atlas       │
│  (Live Cricket Scores)  │      │  (Node / Express / Socket)  │      │  (Matches, Bets, Users) │
└─────────────────────────┘      └──────────────┬──────────────┘      └─────────────────────────┘
                                                │
                                                ▼  WebSocket Broadcasts (Sub-second)
                                 ┌─────────────────────────────┐
                                 │    Next.js Client Apps      │
                                 │  (User & Admin Dashboards)  │
                                 └─────────────────────────────┘
```

---

## 📦 Directory Structure

```
betproexchange-server/
├── server.js                          # Application entry point, HTTP & Socket.io server
├── models/                            # Mongoose Schemas & Data Models
│   ├── Match.js                       # Fixture, score, and market odds schema
│   ├── Bet.js                         # Placed bets (Match Odds, Toss, Bookmaker, Fancy)
│   ├── User.js                        # User balances, hierarchy roles, credit limits
│   └── Settlement.js                  # P/L settlement audits & audit logs
├── routes/                            # REST API Endpoints
│   ├── matchRoutes.js                 # Fixture feeds, live markets, and exposure calculations
│   ├── adminRoutes.js                 # Hierarchy management, winner declarations & exposures
│   └── userRoutes.js                  # User profile, wallet, and placed bets history
├── services/                          # Core Business Logic & Real-Time Engines
│   ├── tossOddsEngine.js              # Universal toss odds (1.98/2.02), pre-match lock & sweep
│   ├── scoreService.js                # Sportmonks & OddsPapi live cricket score synchronization
│   ├── sportmonksScoreService.js      # Ball-by-ball, overs, wickets, and run rate calculations
│   ├── fancyMarketsService.js         # Extraction of Fancy-2, Figure (0-9), Even/Odd, and Tied Match
│   ├── statusService.js               # Fixture lifecycle monitor (upcoming -> live -> completed)
│   ├── resultSettlementService.js     # Automatic match result fetching & settlement trigger
│   ├── settlementService.js           # Multi-market bet resolution (Match Odds, Bookmaker, Tied)
│   ├── hierarchyService.js            # 4-tier shareholder profit/loss distribution engine
│   ├── oddsWebsocketService.js        # Persistent WebSocket client connecting to v5.oddspapi.io/ws
│   └── apiManager.js                  # Rate-limited REST HTTP client for OddsPapi endpoints
├── jobs/                              # Scheduled Background Cron Tasks
│   └── matchFetch.job.js              # Periodic fixture synchronizer (every 15 mins)
├── middleware/                        # Express Middlewares
│   └── auth.js                        # JWT verification & multi-role authorization guard
├── scripts/                           # Maintenance & Database Seeding
│   ├── seedSuperAdmin.js              # Creates root SuperAdmin account
│   └── resetSystem.js                 # Test database cleanup and re-initialization
└── test/                              # Built-in Node.js Test Runner Test Suites
    ├── betCalc.test.js                # Mathematical verification of Back/Lay & Fancy P/L
    ├── currentPositionAndDistribution.test.js # Multi-tier hierarchy share split tests
    ├── oddsValidationAndToss.test.js  # Universal toss odds & order odds validation tests
    └── tossMarketGlitch.test.js       # Sweep logic & UI winner highlighting tests
```

---

## 🔑 Key Features & Services

### 1. Universal Toss Odds Engine (`services/tossOddsEngine.js`)
* **Universal Pre-Match Odds**: Generates synthetic, mathematically balanced toss odds strictly at **1.98 for Back** and **2.02 for Lay** with randomized depth volumes.
* **Pre-Match Locking**: Cricket tosses occur 25–30 minutes before match start. Once a fixture reaches its start time or transitions to `live`, the toss market is marked `CLOSED` and live odds are nullified.
* **Non-destructive Winner Declaration**: Settle via admin action or API with automatic payout and loss distribution across hierarchy levels.

### 2. Multi-Market Extraction Pipeline (`services/fancyMarketsService.js`)
* **Match Odds (H2H)**: Market 271 with full Back and Lay depth arrays.
* **Bookmaker Market**: Normalized bookmaker rates with automated price offsetting and suspension toggling.
* **Figure Market**: Unique last-digit run prediction grid (Digits 0–9) derived from over totals at fixed 8.85 odds.
* **Even / Odd Market**: Team total run parity (Kalli / Jotti) quotes extracted from feed (Market 2724029).
* **Tied Match**: Direct draw/tied match market extraction (Market 276 / 274).

### 3. Shareholder Hierarchy Distribution (`services/hierarchyService.js`)
* Transparent, cascading Profit/Loss distribution across a 4-tier hierarchy:
  $$\text{User} \longrightarrow \text{Master} \longrightarrow \text{Super Master} \longrightarrow \text{Admin} \longrightarrow \text{Super Admin} \longrightarrow \text{Platform}$$
* Computes net share percentages, applies platform fees exclusively on net profit, and audits parent liabilities.

---

## 🛠️ Technology Stack

| Component | Technology |
|---|---|
| **Runtime** | [Node.js](https://nodejs.org/) (ES6+ / CommonJS) |
| **HTTP Framework** | [Express 5](https://expressjs.com/) |
| **Database** | [MongoDB](https://www.mongodb.com/) via [Mongoose 9](https://mongoosejs.com/) |
| **Real-time WebSockets** | [Socket.io 4.8](https://socket.io/) (Engine.IO v4) |
| **Authentication** | [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken) & [bcryptjs](https://github.com/dcodeIO/bcrypt.js) |
| **External Feeds** | [OddsPapi v5](https://v5.oddspapi.io/) & [Sportmonks Cricket API](https://www.sportmonks.com/) |
| **Test Runner** | Native Node.js Test Runner (`node:test` & `node:assert/strict`) |

---

## 🚀 Getting Started

### 1. Prerequisites
* **Node.js**: v18.0.0 or higher (v24.x recommended)
* **MongoDB**: A running MongoDB instance (Local or MongoDB Atlas cluster)

### 2. Environment Configuration
Create a `.env` file in `betproexchange-server/` (see [`.env.example`](file:///Users/admin/Desktop/betpro-project/betproexchange-server/.env.example)):
```env
PORT=5000
MONGO_URI=mongodb+srv://<username>:<password>@cluster.mongodb.net/betpro?retryWrites=true&w=majority
JWT_SECRET=your_secure_jwt_random_secret_string
ODDS_API_KEY=your_oddspapi_v5_api_key
SPORTMONKS_API_KEY=your_sportmonks_api_key
```

### 3. Install Dependencies
```bash
npm install
```

### 4. Seed Root SuperAdmin
```bash
node scripts/seedSuperAdmin.js
```

### 5. Run Server
```bash
npm start
```
Server starts on `http://localhost:5000` with WebSocket listeners enabled.

### 6. Run Test Suite
```bash
npm test
```
Executes all 34 unit and integration test suites:
```
✔ Match Odds: back & lay math
✔ Hierarchy Share Split (Master, SuperMaster, Admin, SuperAdmin)
✔ Universal Toss Odds & validation
✔ Toss Market Sweep Query & persistence
ℹ pass 34
ℹ fail 0
```

---

## 📡 API Reference Overview

### Public & Betting Endpoints
* `GET /api/matches` — List all matches with live scores, match odds, and toss status.
* `GET /api/matches/:id` — Single fixture details with all active markets (Bookmaker, Toss, Fancy, Figure).
* `POST /api/user/bet` — Place a bet (`match_odds`, `toss`, `bookmaker`, `fancy`, `figure`, `even_odd`, `tied_match`).
* `GET /api/user/bets` — Retrieve placed bets history with settlement status.
* `GET /api/user/wallet` — Retrieve current wallet balance and active exposure.

### Admin Governance Endpoints (Requires Bearer Token)
* `POST /api/admin/declare-toss-winner` — Declare toss winner team or `REFUND` to trigger immediate settlement.
* `POST /api/admin/declare-match-winner` — Conclude match and distribute all remaining open bets.
* `GET /api/admin/match-exposure/:matchId` — Hierarchy-adjusted exposure book per runner.
* `GET /api/admin/toss-exposure/:matchId` — Detailed toss market liability summary.

---

## 📄 License

Proprietary and Confidential. Unauthorized copying, transferring, or reproduction of this software via any medium is strictly prohibited.
