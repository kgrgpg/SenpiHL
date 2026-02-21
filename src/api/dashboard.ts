import type { FastifyInstance } from 'fastify';

export async function dashboardRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get('/dashboard', async (_request, reply) => {
    return reply.type('text/html').send(DASHBOARD_HTML);
  });
}

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PnL Indexer Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>
    [x-cloak] { display: none !important; }
    body { font-family: 'Inter', system-ui, -apple-system, sans-serif; }
    .scrollbar-thin::-webkit-scrollbar { width: 6px; }
    .scrollbar-thin::-webkit-scrollbar-track { background: #1e293b; }
    .scrollbar-thin::-webkit-scrollbar-thumb { background: #475569; border-radius: 3px; }
  </style>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: { extend: { colors: { brand: '#8b5cf6' } } }
    }
  </script>
</head>
<body class="bg-slate-950 text-slate-200 min-h-screen" x-data="dashboard()" x-init="init()">

  <!-- Header -->
  <header class="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
      <div class="flex items-center gap-3">
        <h1 class="text-lg font-bold text-white">PnL Indexer</h1>
        <span class="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">v1.2.0</span>
      </div>
      <div class="flex items-center gap-4">
        <nav class="flex gap-1">
          <button @click="tab = 'overview'" :class="tab === 'overview' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'" class="px-3 py-1.5 text-sm rounded-md transition">Overview</button>
          <button @click="tab = 'trader'" :class="tab === 'trader' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'" class="px-3 py-1.5 text-sm rounded-md transition">Trader</button>
          <button @click="tab = 'feed'" :class="tab === 'feed' ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white'" class="px-3 py-1.5 text-sm rounded-md transition">Live Feed</button>
        </nav>
        <div class="flex items-center gap-1.5">
          <span class="w-2 h-2 rounded-full" :class="status.connected ? 'bg-emerald-400 animate-pulse' : 'bg-red-400'"></span>
          <span class="text-xs text-slate-500" x-text="status.connected ? 'Live' : 'Disconnected'"></span>
        </div>
      </div>
    </div>
  </header>

  <main class="max-w-7xl mx-auto px-4 py-6">

    <!-- TAB: Overview -->
    <div x-show="tab === 'overview'" x-cloak>

      <!-- Stat Cards -->
      <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
        <div class="bg-slate-900 border border-slate-800 rounded-lg p-4">
          <div class="text-2xl font-bold text-white" x-text="fmt(status.traders)">--</div>
          <div class="text-xs text-slate-500 mt-1">Traders</div>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-lg p-4">
          <div class="text-2xl font-bold text-white" x-text="fmt(status.snapshots)">--</div>
          <div class="text-xs text-slate-500 mt-1">Snapshots</div>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-lg p-4">
          <div class="text-2xl font-bold text-white" x-text="fmt(status.trades)">--</div>
          <div class="text-xs text-slate-500 mt-1">Trades Stored</div>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-lg p-4">
          <div class="text-2xl font-bold text-violet-400" x-text="status.mode || '--'">--</div>
          <div class="text-xs text-slate-500 mt-1">Mode</div>
        </div>
        <div class="bg-slate-900 border border-slate-800 rounded-lg p-4">
          <div class="text-2xl font-bold text-white" x-text="status.discovered">--</div>
          <div class="text-xs text-slate-500 mt-1">Discovered</div>
        </div>
      </div>

      <!-- Leaderboard -->
      <div class="bg-slate-900 border border-slate-800 rounded-lg">
        <div class="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 class="text-sm font-semibold text-white">Leaderboard</h2>
          <div class="flex gap-1">
            <template x-for="tf in ['1d','7d','30d']">
              <button @click="lbTimeframe = tf; fetchLeaderboard()" :class="lbTimeframe === tf ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-400'" class="px-2.5 py-1 text-xs rounded transition" x-text="tf"></button>
            </template>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-xs text-slate-500 border-b border-slate-800">
                <th class="text-left px-4 py-2 w-12">#</th>
                <th class="text-left px-4 py-2">Address</th>
                <th class="text-right px-4 py-2">Delta PnL</th>
              </tr>
            </thead>
            <tbody>
              <template x-for="(entry, i) in leaderboard" :key="i">
                <tr class="border-b border-slate-800/50 hover:bg-slate-800/40 cursor-pointer transition" @click="viewTrader(entry.address)">
                  <td class="px-4 py-2.5 text-slate-500 font-mono text-xs" x-text="entry.rank"></td>
                  <td class="px-4 py-2.5 font-mono text-xs text-slate-300" x-text="entry.address.slice(0,6) + '...' + entry.address.slice(-4)"></td>
                  <td class="px-4 py-2.5 text-right font-mono text-xs" :class="parseFloat(entry.total_pnl) >= 0 ? 'text-emerald-400' : 'text-red-400'" x-text="'$' + fmtPnl(entry.total_pnl)"></td>
                </tr>
              </template>
              <tr x-show="leaderboard.length === 0">
                <td colspan="3" class="px-4 py-8 text-center text-slate-600">Loading...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- TAB: Trader View -->
    <div x-show="tab === 'trader'" x-cloak>

      <!-- Search -->
      <div class="flex gap-2 mb-6">
        <input type="text" x-model="traderAddress" @keydown.enter="fetchTrader()" placeholder="Enter trader address (0x...)" class="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-violet-500 font-mono" />
        <button @click="fetchTrader()" class="bg-violet-600 hover:bg-violet-500 text-white px-5 py-2.5 rounded-lg text-sm font-medium transition">Search</button>
      </div>

      <!-- Trader Data -->
      <template x-if="traderData">
        <div>
          <!-- Address -->
          <div class="text-xs text-slate-500 mb-4 font-mono" x-text="traderAddress"></div>

          <!-- PnL Cards (Our Calculation) -->
          <div class="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
            <div class="bg-slate-900 border border-slate-800 rounded-lg p-4">
              <div class="text-xs text-slate-500 mb-1">Total PnL</div>
              <div class="text-xl font-bold" :class="parseFloat(traderData.summary.total_pnl || '0') >= 0 ? 'text-emerald-400' : 'text-red-400'" x-text="'$' + fmtPnl(traderData.summary.total_pnl || '0')"></div>
            </div>
            <div class="bg-slate-900 border border-slate-800 rounded-lg p-4">
              <div class="text-xs text-slate-500 mb-1">Realized</div>
              <div class="text-xl font-bold text-white" x-text="'$' + fmtPnl(traderData.summary.realized_pnl || '0')"></div>
            </div>
            <div class="bg-slate-900 border border-slate-800 rounded-lg p-4">
              <div class="text-xs text-slate-500 mb-1">Unrealized</div>
              <div class="text-xl font-bold" :class="parseFloat(traderData.summary.unrealized_pnl || '0') >= 0 ? 'text-emerald-400' : 'text-red-400'" x-text="'$' + fmtPnl(traderData.summary.unrealized_pnl || '0')"></div>
            </div>
            <div class="bg-slate-900 border border-slate-800 rounded-lg p-4">
              <div class="text-xs text-slate-500 mb-1">Trades</div>
              <div class="text-xl font-bold text-white" x-text="(traderData.summary.trade_count || 0).toLocaleString()"></div>
            </div>
            <div class="bg-slate-900 border border-slate-800 rounded-lg p-4">
              <div class="text-xs text-slate-500 mb-1">Volume</div>
              <div class="text-xl font-bold text-white" x-text="'$' + fmtPnl(traderData.summary.volume || '0')"></div>
            </div>
          </div>

          <!-- Data source info -->
          <div x-show="traderData.sources" class="mb-4 bg-slate-800/50 rounded-lg px-3 py-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
            <span>Total PnL: <span class="text-slate-400" x-text="traderData.sources?.total_pnl"></span></span>
            <span>Realized: <span class="text-slate-400" x-text="traderData.sources?.realized_pnl"></span></span>
            <span>Chart: <span class="text-slate-400" x-text="traderData.sources?.chart"></span></span>
          </div>

          <!-- Chart -->
          <div class="bg-slate-900 border border-slate-800 rounded-lg p-4 mb-4">
            <div class="flex items-center justify-between mb-3">
              <h3 class="text-sm font-semibold text-white">PnL Over Time</h3>
              <div class="flex gap-1">
                <template x-for="tf in ['1h','1d','7d','30d']">
                  <button @click="traderTimeframe = tf; fetchTrader()" :class="traderTimeframe === tf ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-400'" class="px-2.5 py-1 text-xs rounded transition" x-text="tf"></button>
                </template>
              </div>
            </div>
            <div class="h-64">
              <canvas id="pnlChart"></canvas>
            </div>
          </div>

          <div class="flex items-center justify-between mt-2">
            <div x-show="traderData.fetched_live" class="text-xs text-violet-400">Fetched live from Hyperliquid</div>
            <div class="text-xs text-slate-600" x-text="traderData.data.length + ' data points'"></div>
          </div>
        </div>
      </template>

      <div x-show="!traderData && !traderLoading" class="text-center py-16 text-slate-600">
        <div class="text-4xl mb-3">&#x1F50D;</div>
        <div>Enter a trader address or click one from the leaderboard</div>
      </div>

      <div x-show="traderLoading" class="text-center py-16 text-slate-500">
        <div class="inline-block w-8 h-8 border-2 border-slate-600 border-t-violet-500 rounded-full animate-spin mb-3"></div>
        <div>Fetching PnL data from Hyperliquid...</div>
        <div class="text-xs text-slate-600 mt-1">This may take a few seconds for full history</div>
      </div>
    </div>

    <!-- TAB: Live Feed -->
    <div x-show="tab === 'feed'" x-cloak>
      <div class="bg-slate-900 border border-slate-800 rounded-lg">
        <div class="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <h2 class="text-sm font-semibold text-white">Recent Trades</h2>
          <span class="text-xs text-slate-500">Auto-refresh 5s</span>
        </div>
        <div class="overflow-x-auto max-h-[70vh] overflow-y-auto scrollbar-thin">
          <table class="w-full text-sm">
            <thead class="sticky top-0 bg-slate-900">
              <tr class="text-xs text-slate-500 border-b border-slate-800">
                <th class="text-left px-4 py-2">Time</th>
                <th class="text-left px-4 py-2">Trader</th>
                <th class="text-left px-4 py-2">Coin</th>
                <th class="text-left px-4 py-2">Side</th>
                <th class="text-right px-4 py-2">Size</th>
                <th class="text-right px-4 py-2">Price</th>
                <th class="text-right px-4 py-2">PnL</th>
              </tr>
            </thead>
            <tbody>
              <template x-for="(trade, i) in recentTrades" :key="trade.tid || i">
                <tr class="border-b border-slate-800/50 hover:bg-slate-800/30 transition">
                  <td class="px-4 py-2 text-xs text-slate-500 font-mono" x-text="new Date(trade.timestamp * 1000).toLocaleTimeString()"></td>
                  <td class="px-4 py-2 text-xs font-mono text-slate-400 cursor-pointer hover:text-violet-400" @click="viewTrader(trade.address)" x-text="trade.address.slice(0,6) + '...' + trade.address.slice(-4)"></td>
                  <td class="px-4 py-2 text-xs font-semibold text-white" x-text="trade.coin"></td>
                  <td class="px-4 py-2 text-xs font-semibold" :class="trade.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'" x-text="trade.side"></td>
                  <td class="px-4 py-2 text-xs text-right font-mono text-slate-300" x-text="parseFloat(trade.size).toFixed(4)"></td>
                  <td class="px-4 py-2 text-xs text-right font-mono text-slate-300" x-text="'$' + parseFloat(trade.price).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})"></td>
                  <td class="px-4 py-2 text-xs text-right font-mono" :class="parseFloat(trade.closed_pnl) > 0 ? 'text-emerald-400' : parseFloat(trade.closed_pnl) < 0 ? 'text-red-400' : 'text-slate-500'" x-text="parseFloat(trade.closed_pnl) !== 0 ? '$' + fmtPnl(trade.closed_pnl) : '-'"></td>
                </tr>
              </template>
              <tr x-show="recentTrades.length === 0">
                <td colspan="7" class="px-4 py-8 text-center text-slate-600">No trades yet...</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

  </main>

  <script>
    function dashboard() {
      return {
        tab: 'overview',
        status: { connected: false, traders: 0, snapshots: 0, trades: 0, mode: '', discovered: 0 },
        leaderboard: [],
        lbTimeframe: '7d',
        traderAddress: '',
        traderData: null,
        traderLoading: false,
        traderTimeframe: '1d',
        traderCache: {},
        recentTrades: [],
        pnlChart: null,

        async init() {
          await this.fetchStatus();
          await this.fetchLeaderboard();
          await this.fetchRecentTrades();

          setInterval(() => this.fetchStatus(), 10000);
          setInterval(() => {
            if (this.tab === 'feed') this.fetchRecentTrades();
          }, 5000);
        },

        async fetchStatus() {
          try {
            const res = await fetch('/v1/status');
            const data = await res.json();
            this.status = {
              connected: true,
              traders: data.tracking?.database_active_traders || 0,
              snapshots: data.tracking?.total_snapshots || 0,
              trades: data.tracking?.in_memory_traders || 0,
              mode: data.mode || 'unknown',
              discovered: data.discovery?.discovered_count || 0,
            };
          } catch { this.status.connected = false; }
        },

        async fetchLeaderboard() {
          try {
            const res = await fetch('/v1/leaderboard?timeframe=' + this.lbTimeframe + '&limit=15');
            const data = await res.json();
            this.leaderboard = data.data || [];
          } catch { /* ignore */ }
        },

        async fetchRecentTrades() {
          try {
            const res = await fetch('/v1/trades/recent?limit=40');
            const data = await res.json();
            this.recentTrades = data.trades || [];
          } catch { /* ignore */ }
        },

        viewTrader(address) {
          this.traderAddress = address;
          this.tab = 'trader';
          this.fetchTrader();
        },

        async fetchTrader() {
          if (!this.traderAddress) return;

          const cacheKey = this.traderAddress + ':' + this.traderTimeframe;
          const cached = this.traderCache[cacheKey];
          if (cached && Date.now() - cached.ts < 30000) {
            this.traderData = cached.data;
            this.$nextTick(() => this.renderChart(cached.data));
            return;
          }

          this.traderLoading = true;
          this.traderData = null;
          try {
            const res = await fetch('/v1/traders/' + this.traderAddress + '/pnl?timeframe=' + this.traderTimeframe);
            if (!res.ok) throw new Error('Not found');
            const data = await res.json();
            this.traderData = data;
            this.traderCache[cacheKey] = { data, ts: Date.now() };
            this.$nextTick(() => this.renderChart(data));
          } catch(e) {
            this.traderData = null;
          }
          this.traderLoading = false;
        },

        renderChart(data) {
          const canvas = document.getElementById('pnlChart');
          if (!canvas) return;
          if (this.pnlChart) { this.pnlChart.destroy(); this.pnlChart = null; }

          const points = (data.data || []).map(d => ({
            x: new Date(d.timestamp * 1000),
            y: parseFloat(d.total_pnl)
          }));

          if (points.length === 0) return;

          this.pnlChart = new Chart(canvas, {
            type: 'line',
            data: {
              datasets: [{
                label: 'Total PnL',
                data: points,
                borderColor: '#8b5cf6',
                backgroundColor: 'rgba(139,92,246,0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: points.length > 100 ? 0 : 2,
                borderWidth: 2,
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              interaction: { mode: 'index', intersect: false },
              plugins: {
                legend: { display: false },
                tooltip: {
                  backgroundColor: '#1e293b',
                  borderColor: '#475569',
                  borderWidth: 1,
                  titleColor: '#e2e8f0',
                  bodyColor: '#94a3b8',
                  callbacks: {
                    label: ctx => '$' + ctx.parsed.y.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                  }
                }
              },
              scales: {
                x: {
                  type: 'time',
                  time: { tooltipFormat: 'MMM d, HH:mm' },
                  grid: { color: '#1e293b' },
                  ticks: { color: '#64748b', maxTicksLimit: 8 }
                },
                y: {
                  grid: { color: '#1e293b' },
                  ticks: {
                    color: '#64748b',
                    callback: v => '$' + (Math.abs(v) >= 1000 ? (v/1000).toFixed(1) + 'K' : v.toFixed(0))
                  }
                }
              }
            }
          });
        },

        fmt(n) { return n != null ? n.toLocaleString() : '--'; },
        fmtPnl(v) {
          const n = parseFloat(v);
          if (isNaN(n)) return '0.00';
          if (Math.abs(n) >= 1e6) return (n/1e6).toFixed(2) + 'M';
          if (Math.abs(n) >= 1e3) return (n/1e3).toFixed(2) + 'K';
          return n.toFixed(2);
        }
      };
    }
  </script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
</body>
</html>`;
