{{-- Custom dashboard for Firefly III 6.7.9. Mount this file and the assets directory read-only. --}}
@extends('layout.v3.session')

@section('content')
    @php
        $dashboardCurrency = \FireflyIII\Support\Facades\Amount::getPrimaryCurrency();
        $dashboardRevision = '20261105-2';
    @endphp
    <link rel="stylesheet" href="{{ asset('custom-dashboard/dashboard.css') }}?v={{ $dashboardRevision }}">

    <main id="custom-dashboard" class="cd-dashboard"
          data-start="{{ $start->format('Y-m-d') }}" data-end="{{ $end->format('Y-m-d') }}"
          data-today="{{ today(config('app.timezone'))->format('Y-m-d') }}"
          data-timezone="{{ config('app.timezone') }}"
          data-currency="{{ $dashboardCurrency->code }}"
          data-decimals="{{ $dashboardCurrency->decimal_places }}"
          data-anonymous="{{ $anonymous ? 'true' : 'false' }}"
          data-daterange-url="{{ route('daterange') }}" aria-label="财务首页">
        <div class="cd-toolbar">
            <div>
                <p class="cd-eyebrow">MY LEDGER <span> / </span> 我的账本</p>
                <h1>收支一览<span class="cd-title-dot"></span></h1>
            </div>
            <div class="cd-controls">
                <div class="cd-month-control" role="group" aria-label="切换月份">
                    <button type="button" data-action="previous" aria-label="上个月"><i class="bi bi-chevron-left" aria-hidden="true"></i></button>
                    <label class="cd-sr-only" for="cd-month">月份</label>
                    <input id="cd-month" type="month" min="1900-01" max="2100-12" value="{{ $start->format('Y-m') }}">
                    <button type="button" data-action="next" aria-label="下个月"><i class="bi bi-chevron-right" aria-hidden="true"></i></button>
                </div>
                <label class="cd-sr-only" for="cd-currency">展示币种</label>
                <select id="cd-currency" aria-label="展示币种"><option>{{ $dashboardCurrency->code }}</option></select>
                <button class="cd-button cd-refresh" type="button" data-action="refresh"><i class="bi bi-arrow-clockwise" aria-hidden="true"></i><span>刷新</span></button>
            </div>
        </div>

        <div class="cd-meta"><span id="cd-range">{{ $start->format('Y-m-d') }} — {{ $end->format('Y-m-d') }}</span><span>全部账户 · 币种分别统计</span></div>
        <p id="cd-status" class="cd-status" role="status" aria-live="polite">正在读取账本…</p>

        <div class="cd-grid" id="cd-grid" aria-busy="true">
            <section class="cd-card cd-summary" aria-labelledby="cd-summary-title">
                <div class="cd-card-heading"><h2 id="cd-summary-title"><span id="cd-period">本月</span> · 支出</h2><button type="button" class="cd-icon-button" data-action="privacy" aria-label="隐藏金额" aria-pressed="false"><i id="cd-eye" class="bi bi-eye" aria-hidden="true"></i></button></div>
                <p id="cd-expense" class="cd-hero-amount cd-sensitive">—</p>
                <div class="cd-income-pill"><span class="cd-dot"></span>当期收入 <strong id="cd-income" class="cd-sensitive">—</strong></div>
                <div class="cd-summary-footer"><span>当期结余 <strong id="cd-surplus" class="cd-sensitive">—</strong></span><a href="{{ route('transactions.index', ['withdrawal', $start->format('Y-m-d'), $end->format('Y-m-d')]) }}">查看交易 <i class="bi bi-arrow-up-right" aria-hidden="true"></i></a></div>
                <i class="bi bi-receipt cd-summary-art" aria-hidden="true"></i>
                <p class="cd-card-message" id="cd-month-error" role="alert" hidden></p>
            </section>

            <section class="cd-card cd-assets" aria-labelledby="cd-assets-title">
                <div class="cd-card-heading"><h2 id="cd-assets-title"><i class="bi bi-bank" aria-hidden="true"></i>资产概要</h2><a href="{{ route('accounts.index', ['asset']) }}" class="cd-muted-link">账户 <i class="bi bi-arrow-up-right" aria-hidden="true"></i></a></div>
                <p class="cd-subtitle" id="cd-account-info">正在读取账户余额…</p>
                <div class="cd-asset-grid">
                    <div class="cd-asset-item"><span class="cd-asset-icon"><i class="bi bi-bank" aria-hidden="true"></i></span><div><p>总资产</p><strong id="cd-assets" class="cd-sensitive">—</strong></div></div>
                    <div class="cd-asset-item"><span class="cd-asset-icon cd-teal"><i class="bi bi-credit-card" aria-hidden="true"></i></span><div><p>总负债</p><strong id="cd-debts" class="cd-sensitive">—</strong></div></div>
                    <div class="cd-asset-item"><span class="cd-asset-icon cd-orange"><i class="bi bi-piggy-bank" aria-hidden="true"></i></span><div><p>净资产</p><strong id="cd-net" class="cd-sensitive">—</strong></div></div>
                </div>
                <p class="cd-footnote" id="cd-asset-note">按计入净资产的账户统计，扣除虚拟余额。</p>
                <p class="cd-card-message" id="cd-account-error" role="alert" hidden></p>
            </section>

            <section class="cd-card cd-heatmap" aria-labelledby="cd-heatmap-title">
                <div class="cd-card-heading"><h2 id="cd-heatmap-title"><i class="bi bi-calendar3" aria-hidden="true"></i>交易日历热力图</h2><span id="cd-heat-range" class="cd-small">最近一年</span></div>
                <div class="cd-heat-scroll" id="cd-heat-scroll"><p class="cd-empty">正在读取全年交易…</p></div>
                <div class="cd-heat-footer"><span id="cd-heat-status" role="status">全部币种 · 每日收支及转账明细笔数</span><span class="cd-heat-legend" aria-label="颜色越亮，交易越多">少 <b></b><b></b><b></b><b></b><b></b> 多</span></div>
            </section>

            <section class="cd-card cd-calendar" aria-labelledby="cd-calendar-title">
                <div class="cd-card-heading"><h2 id="cd-calendar-title"><i class="bi bi-calendar-week" aria-hidden="true"></i>交易日历</h2><span id="cd-calendar-month" class="cd-small"></span></div>
                <div class="cd-calendar-legend"><span><b class="cd-legend-dot cd-orange-bg"></b>支出</span><span><b class="cd-legend-dot cd-teal-bg"></b>收入</span><span>点击日期查看明细</span></div>
                <div class="cd-weekdays" aria-hidden="true"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
                <div id="cd-calendar-days" class="cd-calendar-days"><p class="cd-empty">正在加载…</p></div>
            </section>

            <section class="cd-card cd-ranking" aria-labelledby="cd-ranking-title">
                <div class="cd-card-heading"><h2 id="cd-ranking-title"><i class="bi bi-sort-down" aria-hidden="true"></i>分类排行</h2><div class="cd-segment" role="group" aria-label="分类统计类型"><button type="button" data-ranking="withdrawal" aria-pressed="true">支出</button><button type="button" data-ranking="deposit" aria-pressed="false">收入</button></div></div>
                <div id="cd-ranking-list" class="cd-ranking-list"><p class="cd-empty">正在加载…</p></div>
            </section>

            <section class="cd-card cd-trend" aria-labelledby="cd-trend-title">
                <div class="cd-card-heading"><h2 id="cd-trend-title"><i class="bi bi-bar-chart-line" aria-hidden="true"></i>收支趋势</h2><div class="cd-segment" role="group" aria-label="趋势统计方式"><button type="button" data-trend="daily" aria-pressed="true">每日</button><button type="button" data-trend="cumulative" aria-pressed="false">累计</button></div></div>
                <div class="cd-chart-legend"><span><b class="cd-legend-dot cd-orange-bg"></b>支出</span><span><b class="cd-legend-dot cd-teal-bg"></b>收入</span></div>
                <div id="cd-trend-chart" class="cd-trend-chart"><p class="cd-empty">正在加载…</p></div>
            </section>
        </div>

        <section class="cd-period-section" aria-label="今天、本周、本月和今年收支">
            <div class="cd-period-heading"><p>时间概览</p><span id="cd-period-status" class="cd-small" role="status" aria-live="polite">按当前日期统计，独立于上方日期范围</span></div>
            <div class="cd-period-grid" id="cd-period-grid" aria-busy="true">
                @foreach(['today' => ['今天', 'bi-calendar-day'], 'week' => ['本周', 'bi-calendar-week'], 'month' => ['本月', 'bi-calendar3'], 'year' => ['今年', 'bi-layers']] as $periodKey => [$periodTitle, $periodIcon])
                    <article class="cd-card cd-period-card" aria-labelledby="cd-period-title-{{ $periodKey }}">
                        <div class="cd-card-heading">
                            <h2 id="cd-period-title-{{ $periodKey }}"><i class="bi {{ $periodIcon }}" aria-hidden="true"></i>{{ $periodTitle }}</h2>
                            <details class="cd-period-menu">
                                <summary aria-label="{{ $periodTitle }}的操作"><i class="bi bi-three-dots-vertical" aria-hidden="true"></i></summary>
                                <div><button type="button" data-period-open="{{ $periodKey }}">在上方查看此期间</button></div>
                            </details>
                        </div>
                        <p class="cd-period-label"><b class="cd-legend-dot cd-period-income-dot"></b>收入</p>
                        <p id="cd-period-{{ $periodKey }}-income" class="cd-period-amount cd-period-income cd-sensitive">—</p>
                        <p class="cd-period-label"><b class="cd-legend-dot cd-teal-bg"></b>支出</p>
                        <p id="cd-period-{{ $periodKey }}-expense" class="cd-period-amount cd-period-expense cd-sensitive">—</p>
                        <p id="cd-period-{{ $periodKey }}-range" class="cd-period-range"></p>
                    </article>
                @endforeach
            </div>
            <p id="cd-period-error" class="cd-card-message" role="alert" hidden></p>
        </section>

        <p class="cd-page-note">收支按账本入账币种统计，包含未分类；账户间转账和信用卡还款不计收支。退款按收入记录展示，不自动抵扣原支出。下方时间概览使用当前自然日、周、月、年；本周为周日至周六，包含期间内已录入的未来交易。</p>
        <noscript><p class="cd-card-message">请启用 JavaScript 以加载首页统计。</p></noscript>
        <dialog id="cd-day-dialog" class="cd-dialog" aria-labelledby="cd-day-title">
            <div class="cd-card-heading"><h2 id="cd-day-title">交易明细</h2><button type="button" class="cd-icon-button" data-action="close-dialog" aria-label="关闭明细"><i class="bi bi-x-lg" aria-hidden="true"></i></button></div>
            <p class="cd-small" id="cd-day-info"></p><div id="cd-day-list"></div>
        </dialog>
    </main>
@endsection

@section('scripts')
    {{-- Keep the official bootstrap for the sidebar, date picker and session preferences.
         No x-data="index"/"boxes" is used above, so the old dashboard charts are not started. --}}
    @vite(['js/pages/dashboard/dashboard.js'])
    <script type="module" nonce="{{ $JS_NONCE }}" src="{{ asset('custom-dashboard/dashboard.js') }}?v=20261105-2"></script>
@endsection
