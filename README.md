# Signal Deck Futures Dashboard

A small MES/ES paper-trading dashboard based on Signal Deck Futures framework.

It runs a local server, pulls public Yahoo Finance chart/RSS data, computes MACD, RSI/VWAP, a volume-delta proxy, local pattern context, VIX/yield macro reads, and renders a live dashboard with an action of `LONG`, `SHORT`, or `WAIT`.

## Run

```sh
npm start
```

Open `http://localhost:5174`.

Node v26.3.0 is verified for this project. If a non-interactive tool shell cannot find Node, run through your login shell:

```sh
bash -lc 'npm start'
```

## Test

```sh
npm test
```

The suite uses the Node built-in test runner, so no Jest install is required.

## API

```text
GET /api/analyze?symbol=ES=F&account=1000
```

The default symbol is `ES=F`. The UI also includes `MES=F` and `NQ=F`, but Yahoo availability can vary.

## Data Notes

- Yahoo Finance data can be delayed and may not match a broker feed.
- `ES=F` is a continuous/front-month proxy, not a guaranteed exact exchange front-month contract code.
- True bid/ask CVD is not available from Yahoo chart data, so the dashboard labels CVD as a candle-volume proxy.
- If data is stale, closed, too risky for the paper account cap, or a binary macro headline is detected, the analysis returns `WAIT`.

## Disclaimer

Paper trading education only. This is not financial advice. Futures are leveraged instruments and can lose more than the initial deposit.
