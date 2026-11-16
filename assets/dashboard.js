/* Custom dashboard for Firefly III 6.7.9. No tokens, third-party requests or financial data in browser storage. */
const SCALE = 10n ** 12n;
const MAX_PAGES = 500;
const SVG_NS = "http://www.w3.org/2000/svg";

// Keep Firefly's 12-place precision until display; do not round each split to cents.
function parseAmount(value) {
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(String(value ?? ""));
    if (!match || (match[3]?.length > 12 && /[1-9]/.test(match[3].slice(12)))) {
        throw new Error("账本包含无效金额，无法安全汇总。");
    }
    const amount = BigInt(match[2]) * SCALE + BigInt((match[3] || "").slice(0, 12).padEnd(12, "0"));
    return match[1] === "-" ? -amount : amount;
}

function currencyInfo(record) {
    const code = String(record.currency_code || "");
    const decimals = Number(record.currency_decimal_places);
    if (!/^[A-Z][A-Z0-9]{2,11}$/.test(code) || !Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
        throw new Error("账本包含无法识别的币种或小数位数。");
    }
    return { code, decimals };
}

function formatAmount(value, currency, decimals = 2, hidden = false, withCode = true) {
    if (hidden) return "••••";
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    const divisor = 10n ** BigInt(12 - decimals);
    const rounded = (absolute + divisor / 2n) / divisor;
    const places = 10n ** BigInt(decimals);
    const integer = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(rounded / places);
    const fraction = decimals ? "." + String(rounded % places).padStart(decimals, "0") : "";
    return `${withCode ? currency + " " : ""}${negative && rounded !== 0n ? "−" : ""}${integer}${fraction}`;
}

function dateKey(value, timeZone) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) throw new Error("交易日期无效，无法按日汇总。");
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const part = (type) => parts.find((item) => item.type === type).value;
    return `${part("year")}-${part("month")}-${part("day")}`;
}

function shiftDay(day, offset) {
    const date = new Date(day + "T12:00:00Z");
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
}

function dayRange(start, end) {
    const result = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || start > end) {
        throw new Error("日期范围无效，请重新选择月份。");
    }
    for (let day = start; day <= end; day = shiftDay(day, 1)) {
        if (result.length >= 370) throw new Error("首页最多展示一年，请用顶部月份选择器缩小范围。");
        result.push(day);
    }
    return result;
}

function monthRange(month) {
    if (!/^(19\d{2}|20\d{2}|2100)-(0[1-9]|1[0-2])$/.test(month)) throw new Error("请选择有效月份（1900—2100 年）。");
    const [year, number] = month.split("-").map(Number);
    const last = new Date(Date.UTC(year, number, 0)).getUTCDate();
    return { start: month + "-01", end: month + "-" + String(last).padStart(2, "0") };
}

function currentPeriodRanges(today) {
    dayRange(today, today);
    const weekStart = shiftDay(today, -new Date(today + "T12:00:00Z").getUTCDay());
    const year = today.slice(0, 4);
    return {
        today: { start: today, end: today },
        week: { start: weekStart, end: shiftDay(weekStart, 6) },
        month: monthRange(today.slice(0, 7)),
        year: { start: year + "-01-01", end: year + "-12-31" },
    };
}

function aggregatePeriodTotals(rows, currency, ranges) {
    const totals = Object.fromEntries(Object.keys(ranges).map((key) => [key, { income: 0n, expense: 0n }]));
    for (const row of rows) {
        if (row.currency !== currency || !["withdrawal", "deposit"].includes(row.type)) continue;
        for (const [key, range] of Object.entries(ranges)) {
            if (row.day < range.start || row.day > range.end) continue;
            if (row.type === "deposit") totals[key].income += row.amount;
            else totals[key].expense += row.amount;
        }
    }
    return totals;
}

function rememberCurrency(map, info) {
    if (map.has(info.code) && map.get(info.code).decimals !== info.decimals) throw new Error("同一币种的小数位数不一致，请核对账本设置。");
    if (!map.has(info.code)) map.set(info.code, info);
}

function flattenTransactions(groups, start, end, timeZone) {
    const rows = [];
    const seen = new Set();
    const currencies = new Map();
    for (const group of groups) {
        const splits = group.attributes?.transactions;
        if (!Array.isArray(splits)) throw new Error("交易明细格式异常，请刷新重试。");
        for (const split of splits) {
            if (!["withdrawal", "deposit", "transfer"].includes(split.type)) continue;
            const day = dateKey(split.date, timeZone);
            if (day < start || day > end) continue;
            if (!/^\d+$/.test(String(group.id)) || !/^\d+$/.test(String(split.transaction_journal_id))) {
                throw new Error("交易编号缺失，无法核对拆分交易。");
            }
            const key = String(split.transaction_journal_id);
            if (seen.has(key)) continue;
            seen.add(key);
            const info = currencyInfo(split);
            rememberCurrency(currencies, info);
            const amount = parseAmount(split.amount);
            if (amount < 0n) throw new Error("交易金额符号异常，请核对账本。");
            rows.push({ ...split, amount, day, groupId: String(group.id), currency: info.code, decimals: info.decimals });
        }
    }
    return { rows, currencies };
}

function aggregateTransactions(rows, currency, start, end) {
    const days = new Map(dayRange(start, end).map((day) => [day, { income: 0n, expense: 0n, rows: [] }]));
    const categories = { withdrawal: new Map(), deposit: new Map() };
    let income = 0n;
    let expense = 0n;
    for (const row of rows) {
        if (row.currency !== currency || !days.has(row.day)) continue;
        const daily = days.get(row.day);
        daily.rows.push(row);
        if (row.type === "transfer") continue;
        if (row.type === "withdrawal") { expense += row.amount; daily.expense += row.amount; }
        if (row.type === "deposit") { income += row.amount; daily.income += row.amount; }
        const name = row.category_name || "未分类";
        const key = row.category_id ? `id:${row.category_id}` : `name:${name}`;
        const category = categories[row.type].get(key) || { name, amount: 0n };
        category.amount += row.amount;
        categories[row.type].set(key, category);
    }
    return { income, expense, days, categories };
}

function aggregateAccounts(accounts) {
    const currencies = new Map();
    const balances = new Map();
    const seen = new Set();
    let includedCount = 0;
    for (const account of accounts) {
        if (seen.has(String(account.id))) continue;
        seen.add(String(account.id));
        const value = account.attributes;
        if (!value) throw new Error("账户信息格式异常。");
        const info = currencyInfo(value);
        rememberCurrency(currencies, info);
        if (value.include_net_worth !== true) continue;
        includedCount++;
        // Match Firefly's NetWorth helper: balances include virtual balance, which must be removed.
        const amount = parseAmount(value.current_balance) - parseAmount(value.virtual_balance ?? "0");
        const current = balances.get(info.code) || { assets: 0n, debts: 0n };
        if (amount >= 0n) current.assets += amount;
        else current.debts -= amount;
        balances.set(info.code, current);
    }
    return { balances, currencies, count: seen.size, includedCount };
}

async function requestJson(url, { signal, fetcher = globalThis.fetch } = {}) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 25000);
    try {
        const csrf = typeof document === "undefined" ? "" : document.querySelector('meta[name="csrf-token"]')?.content || "";
        const response = await fetcher(url, {
            credentials: "same-origin", cache: "no-store", signal: controller.signal,
            headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", "X-CSRF-TOKEN": csrf },
        });
        if ([401, 403, 419].includes(response.status)) throw new Error("登录已过期或访问受限，请刷新页面并重新登录 Firefly。");
        if (!response.ok) throw new Error(`Firefly 接口返回 HTTP ${response.status}，请稍后刷新。`);
        if (!(response.headers.get("content-type") || "").includes("json")) throw new Error("未收到接口数据，请刷新页面并确认登录状态。");
        return await response.json();
    } catch (error) {
        if (error.name === "AbortError" && !signal?.aborted) throw new Error("读取账本超时，请点击刷新重试。");
        throw error;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
    }
}

async function loadPages(path, params, { signal, onProgress, baseUrl, fetcher } = {}) {
    const result = [];
    const seen = new Set();
    let expectedTotal = null;
    for (let page = 1; page <= MAX_PAGES; page++) {
        const url = new URL(path, baseUrl || document.baseURI);
        for (const [key, value] of Object.entries({ ...params, limit: 100, page })) url.searchParams.set(key, value);
        const payload = await requestJson(url, { signal, fetcher });
        const pagination = payload.meta?.pagination;
        const pages = Number(pagination?.total_pages);
        const total = Number(pagination?.total);
        if (!Array.isArray(payload.data) || !pagination || Number(pagination.current_page) !== page ||
            !Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES || !Number.isInteger(total) || total < 0) {
            throw new Error("分页数据不完整或记录过多，请缩小日期范围后重试。");
        }
        if (expectedTotal !== null && expectedTotal !== total) throw new Error("读取期间账本发生变化，请刷新以重新汇总。");
        expectedTotal = total;
        for (const item of payload.data) {
            const id = String(item.id);
            if (seen.has(id)) throw new Error("交易分页出现重复，请刷新后重新读取。");
            seen.add(id);
            result.push(item);
        }
        onProgress?.(page, pages);
        if (page >= pages) {
            if (result.length !== total) throw new Error("账本分页记录数量不一致，请刷新重试。");
            return result;
        }
    }
    throw new Error("分页读取超过上限，未展示不完整合计。");
}

function element(tag, className = "", text = null) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== null) node.textContent = text;
    return node;
}

function empty(target, message) { target.replaceChildren(element("p", "cd-empty", message)); }

function svgElement(tag, attributes = {}, text = null) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== null) node.textContent = text;
    return node;
}

function errorMessage(error) {
    return error instanceof TypeError ? "无法连接 Firefly，请检查网络后刷新重试。" : error.message || "读取失败，请刷新重试。";
}

function startDashboard(root) {
    document.body.classList.add("cd-home");
    const get = (id) => root.querySelector("#cd-" + id);
    const { start, end, today, timezone: timeZone } = root.dataset;
    const assetDate = end < today ? end : today;
    const periodRanges = currentPeriodRanges(today);
    const state = {
        currency: root.dataset.currency, decimals: Number(root.dataset.decimals),
        nativeHidden: root.dataset.anonymous === "true", hidden: false,
        ranking: "withdrawal", trend: "daily", month: null, accounts: null, heat: null, periods: null,
        monthlyController: null, heatController: null, periodController: null, generation: 0,
        monthError: null, accountError: null, heatError: null, dialogDay: null, dialogAllCurrencies: false,
    };
    const currencies = new Map([[state.currency, { code: state.currency, decimals: state.decimals }]]);
    const isHidden = () => state.hidden || state.nativeHidden;
    const money = (value, withCode = true) => formatAmount(value, state.currency, state.decimals, isHidden(), withCode);
    const status = (message, error = false) => { get("status").textContent = message; get("status").classList.toggle("cd-error", error); };
    const showError = (id, message) => { get(id).textContent = message || ""; get(id).hidden = !message; };

    function updateCurrencies() {
        for (const source of [state.month, state.accounts, state.periods]) {
            if (source) for (const info of source.currencies.values()) rememberCurrency(currencies, info);
        }
        get("currency").replaceChildren(...Array.from(currencies.keys()).sort().map((code) => {
            const option = element("option", "", code);
            option.value = code;
            return option;
        }));
        get("currency").value = state.currency;
        state.decimals = currencies.get(state.currency).decimals;
    }

    function renderAccounts() {
        if (!state.accounts) return;
        const value = state.accounts.balances.get(state.currency) || { assets: 0n, debts: 0n };
        get("assets").textContent = money(value.assets);
        get("debts").textContent = money(value.debts);
        get("net").textContent = money(value.assets - value.debts);
        get("account-info").textContent = `已记录 ${state.accounts.count} 个账户 · ${state.accounts.includedCount} 个计入净资产`;
        get("asset-note").textContent = `截至 ${assetDate} · ${state.currency} · 不含虚拟余额，正余额计资产、负余额计负债。`;
    }

    function renderPeriodCards() {
        if (!state.periods) return;
        const totals = aggregatePeriodTotals(state.periods.rows, state.currency, periodRanges);
        for (const [key, total] of Object.entries(totals)) {
            get(`period-${key}-income`).textContent = money(total.income);
            get(`period-${key}-expense`).textContent = money(total.expense);
        }
    }

    function renderRanking(data) {
        const total = state.ranking === "withdrawal" ? data.expense : data.income;
        const items = Array.from(data.categories[state.ranking].values()).sort((a, b) => a.amount === b.amount ? a.name.localeCompare(b.name) : a.amount > b.amount ? -1 : 1);
        root.querySelectorAll("[data-ranking]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.ranking === state.ranking)));
        if (total === 0n) { empty(get("ranking-list"), "当前范围与币种暂无" + (state.ranking === "withdrawal" ? "支出" : "收入")); return; }
        const icons = ["bi-house-door", "bi-basket2", "bi-cup-hot", "bi-bag", "bi-car-front", "bi-grid"];
        get("ranking-list").replaceChildren(...items.map((item, index) => {
            const row = element("div", "cd-rank-row");
            const icon = element("span", "cd-rank-icon");
            icon.setAttribute("aria-hidden", "true");
            icon.append(element("i", "bi " + icons[index % icons.length]));
            const content = element("div", "cd-rank-content");
            const label = element("div", "cd-rank-label");
            label.append(element("span", "", item.name), element("strong", "", money(item.amount)));
            const progress = element("div", "cd-rank-progress");
            const track = element("div", "cd-progress-track");
            const fill = element("span", "cd-progress-fill");
            const percent = Number(item.amount * 10000n / total) / 100;
            fill.style.width = (isHidden() ? 0 : percent) + "%";
            track.setAttribute("aria-hidden", "true");
            track.append(fill);
            progress.append(track, element("span", "", isHidden() ? "•••" : percent.toFixed(1) + "%"));
            content.append(label, progress);
            row.append(icon, content);
            return row;
        }));
    }

    function renderCalendar(data) {
        const month = start.slice(0, 7);
        get("calendar-month").textContent = month;
        const first = new Date(month + "-01T12:00:00Z");
        const last = Number(monthRange(month).end.slice(-2));
        const nodes = [];
        for (let i = 0; i < first.getUTCDay(); i++) { const spacer = element("span"); spacer.setAttribute("aria-hidden", "true"); nodes.push(spacer); }
        for (let number = 1; number <= last; number++) {
            const day = `${month}-${String(number).padStart(2, "0")}`;
            const daily = data.days.get(day);
            const button = element("button", "cd-day" + (day === today ? " cd-today" : "") + (!daily ? " cd-outside" : ""));
            button.type = "button";
            button.append(element("span", "cd-day-number", String(number)));
            const details = [];
            if (daily?.expense > 0n) { const text = money(daily.expense, false); button.append(element("span", "cd-day-value cd-expense-text", text)); details.push("支出 " + text); }
            if (daily?.income > 0n) { const text = money(daily.income, false); button.append(element("span", "cd-day-value cd-income-text", text)); details.push("收入 " + text); }
            button.title = `${day} · ${daily ? (details.join("；") || "暂无收支") : "不在当前日期范围"}`;
            button.setAttribute("aria-label", button.title + (daily ? ` · ${daily.rows.length} 条明细` : ""));
            button.disabled = !daily;
            button.addEventListener("click", () => showDay(day, false));
            nodes.push(button);
        }
        get("calendar-days").replaceChildren(...nodes);
    }

    function renderTrend(data) {
        root.querySelectorAll("[data-trend]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.trend === state.trend)));
        if (isHidden()) { empty(get("trend-chart"), "金额已隐藏"); return; }
        if (data.expense === 0n && data.income === 0n) { empty(get("trend-chart"), "当前范围与币种暂无收支"); return; }
        // Do not draw artificial zero days after today; future booked entries remain in the totals/calendar.
        let runningExpense = 0n, runningIncome = 0n;
        const points = Array.from(data.days).filter(([day]) => day <= today).map(([day, daily]) => {
            runningExpense += daily.expense; runningIncome += daily.income;
            return { day, expense: state.trend === "cumulative" ? runningExpense : daily.expense, income: state.trend === "cumulative" ? runningIncome : daily.income };
        });
        if (!points.length) { empty(get("trend-chart"), "未来日期暂不绘制趋势"); return; }
        const width = 500, height = 260, left = 61, right = 17, top = 16, bottom = 31;
        const plotWidth = width - left - right, plotHeight = height - top - bottom;
        let max = 1n;
        for (const point of points) { if (point.expense > max) max = point.expense; if (point.income > max) max = point.income; }
        max += max / 8n;
        const x = (index) => left + index * plotWidth / Math.max(points.length - 1, 1);
        const y = (value) => top + plotHeight * (1 - Number(value * 1000000n / max) / 1000000);
        const svg = svgElement("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `${state.currency} ${state.trend === "daily" ? "每日" : "累计"}收支趋势，可点击日期查看明细` });
        for (let i = 0; i <= 4; i++) {
            const value = max * BigInt(i) / 4n;
            const yy = y(value);
            svg.append(svgElement("line", { x1: left, x2: width - right, y1: yy, y2: yy, class: "cd-chart-grid" }));
            const number = Number(value / (SCALE / 100n)) / 100;
            const label = number >= 1000000 ? (number / 1000000).toFixed(1) + "m" : number >= 10000 ? (number / 10000).toFixed(1) + "万" : number.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
            svg.append(svgElement("text", { x: left - 8, y: yy + 4, "text-anchor": "end" }, label));
        }
        for (const [kind, css] of [["expense", "cd-chart-expense"], ["income", "cd-chart-income"]]) {
            const coords = points.map((point, index) => `${x(index).toFixed(2)},${y(point[kind]).toFixed(2)}`).join(" ");
            svg.append(svgElement("polygon", { points: `${left},${top + plotHeight} ${coords} ${x(points.length - 1)},${top + plotHeight}`, fill: kind === "expense" ? "#d88e5010" : "#26b9a514" }));
            svg.append(svgElement("polyline", { points: coords, fill: "none", class: css, "stroke-width": 2.4, "stroke-linejoin": "round", "stroke-linecap": "round" }));
            if (points.length === 1) svg.append(svgElement("circle", { cx: x(0), cy: y(points[0][kind]), r: 3, fill: kind === "expense" ? "#d88e50" : "#26b9a5" }));
        }
        const indices = new Set([0, Math.floor((points.length - 1) / 2), points.length - 1]);
        for (const index of indices) svg.append(svgElement("text", { x: x(index), y: height - 6, "text-anchor": index === 0 ? "start" : index === points.length - 1 ? "end" : "middle" }, points[index].day.slice(5)));
        points.forEach((point, index) => {
            const hitWidth = plotWidth / Math.max(points.length - 1, 1);
            const hit = svgElement("rect", { x: Math.max(left, x(index) - hitWidth / 2), y: top, width: Math.min(hitWidth, width - right - Math.max(left, x(index) - hitWidth / 2)), height: plotHeight, class: "cd-chart-hit" });
            hit.append(svgElement("title", {}, `${point.day}\n支出 ${money(point.expense)}\n收入 ${money(point.income)}`));
            hit.addEventListener("click", () => showDay(point.day, false));
            svg.append(hit);
        });
        get("trend-chart").replaceChildren(svg);
    }

    function renderMonth() {
        if (!state.month) return;
        const data = aggregateTransactions(state.month.rows, state.currency, start, end);
        get("expense").textContent = money(data.expense);
        get("income").textContent = money(data.income);
        get("surplus").textContent = money(data.income - data.expense);
        renderRanking(data); renderCalendar(data); renderTrend(data);
    }

    function renderPrivacy() {
        const button = root.querySelector('[data-action="privacy"]');
        button.setAttribute("aria-pressed", String(isHidden()));
        button.setAttribute("aria-label", isHidden() ? "显示金额" : "隐藏金额");
        get("eye").className = "bi " + (isHidden() ? "bi-eye-slash" : "bi-eye");
        renderAccounts(); renderMonth(); renderPeriodCards();
        if (get("day-dialog").open && state.dialogDay) showDay(state.dialogDay, state.dialogAllCurrencies);
    }

    function showDay(day, allCurrencies) {
        state.dialogDay = day; state.dialogAllCurrencies = allCurrencies;
        const source = allCurrencies ? state.heat : state.month;
        const rows = (source?.rows || []).filter((row) => row.day === day && (allCurrencies || row.currency === state.currency));
        get("day-title").textContent = day + " · 交易明细";
        get("day-info").textContent = `${allCurrencies ? "全部币种" : state.currency} · ${rows.length} 条明细 · 拆分交易分别列出`;
        if (!rows.length) empty(get("day-list"), "当天没有交易记录");
        else get("day-list").replaceChildren(...rows.map((row) => {
            const item = element("div", "cd-detail-row");
            const text = element("div");
            const link = element("a", "", row.description || "无描述");
            link.href = new URL("transactions/show/" + row.groupId, document.baseURI).href;
            text.append(link, element("p", "", `${row.source_name || "—"} → ${row.destination_name || "—"} · ${row.category_name || "未分类"}`));
            const type = row.type === "withdrawal" ? "支出" : row.type === "deposit" ? "收入" : "转账";
            const value = element("strong", row.type === "deposit" ? "cd-income-text" : row.type === "withdrawal" ? "cd-expense-text" : "");
            value.append(element("span", "", type + " " + formatAmount(row.amount, row.currency, row.decimals, isHidden())));
            if (row.foreign_currency_code && row.foreign_amount !== null && row.foreign_amount !== undefined) {
                const foreign = currencyInfo({ currency_code: row.foreign_currency_code, currency_decimal_places: row.foreign_currency_decimal_places });
                value.append(element("p", "", "外币 " + formatAmount(parseAmount(row.foreign_amount), foreign.code, foreign.decimals, isHidden())));
            }
            item.append(text, value);
            return item;
        }));
        if (!get("day-dialog").open) get("day-dialog").showModal();
    }

    function renderHeatmap(heatStart, heatEnd) {
        const counts = new Map();
        for (const row of state.heat.rows) counts.set(row.day, (counts.get(row.day) || 0) + 1);
        const first = shiftDay(heatStart, -new Date(heatStart + "T12:00:00Z").getUTCDay());
        const last = shiftDay(heatEnd, 6 - new Date(heatEnd + "T12:00:00Z").getUTCDay());
        const days = [];
        for (let day = first; day <= last; day = shiftDay(day, 1)) days.push(day);
        const layout = element("div", "cd-heat-layout");
        const weekdays = element("div", "cd-heat-weekdays");
        for (const name of ["日", "", "二", "", "四", "", "六"]) weekdays.append(element("span", "", name));
        weekdays.setAttribute("aria-hidden", "true");
        const body = element("div", "cd-heat-body"), months = element("div", "cd-heat-months"), cells = element("div", "cd-heat-cells");
        let lastMonth = "";
        for (let index = 0; index < days.length; index++) {
            const day = days[index], count = counts.get(day) || 0;
            if (index % 7 === 0) {
                const month = day.slice(0, 7);
                months.append(element("span", "", month !== lastMonth ? String(Number(day.slice(5, 7))) + "月" : ""));
                lastMonth = month;
            }
            const level = count === 0 ? 0 : count <= 2 ? 1 : count <= 5 ? 2 : count <= 9 ? 3 : 4;
            const outside = day < heatStart || day > heatEnd;
            const button = element("button", `cd-level-${level}` + (outside ? " cd-future" : ""));
            button.type = "button"; button.disabled = outside;
            button.title = `${day} · ${count} 条交易明细`;
            button.setAttribute("aria-label", button.title);
            button.addEventListener("click", () => showDay(day, true));
            cells.append(button);
        }
        body.append(months, cells); layout.append(weekdays, body);
        get("heat-scroll").replaceChildren(layout);
        get("heat-range").textContent = `${heatStart} — ${heatEnd}`;
        get("heat-status").textContent = `${state.heat.rows.length} 条明细 · 全部币种 · 含转账`;
    }

    async function loadHeatmap() {
        state.heatController?.abort();
        const controller = new AbortController(); state.heatController = controller;
        const heatEnd = assetDate, heatStart = shiftDay(heatEnd, -364);
        state.heat = null; state.heatError = null;
        empty(get("heat-scroll"), "正在读取全年交易…");
        try {
            const groups = await loadPages("api/v1/transactions", { start: heatStart, end: heatEnd, type: "all" }, {
                signal: controller.signal,
                onProgress: (page, pages) => { get("heat-status").textContent = `读取全年交易 ${page}/${pages} 页…`; },
            });
            if (controller.signal.aborted) return;
            state.heat = flattenTransactions(groups, heatStart, heatEnd, timeZone);
            renderHeatmap(heatStart, heatEnd);
        } catch (error) {
            if (controller.signal.aborted) return;
            state.heatError = errorMessage(error);
            empty(get("heat-scroll"), state.heatError);
            get("heat-status").textContent = "全年数据加载失败 · 点击刷新重试";
        }
    }

    async function loadPeriodCards() {
        // Allow the new script to load with the previous template during an in-place bind-mount update.
        if (!get("period-grid")) return;
        state.periodController?.abort();
        const controller = new AbortController(); state.periodController = controller;
        state.periods = null;
        showError("period-error", null);
        get("period-grid").setAttribute("aria-busy", "true");
        for (const key of Object.keys(periodRanges)) {
            get(`period-${key}-income`).textContent = "—";
            get(`period-${key}-expense`).textContent = "—";
        }
        // The week may cross New Year. One complete query covers all four cards, including future booked entries.
        const periodStart = Object.values(periodRanges).map((range) => range.start).sort()[0];
        const periodEnd = Object.values(periodRanges).map((range) => range.end).sort().at(-1);
        try {
            const groups = await loadPages("api/v1/transactions", { start: periodStart, end: periodEnd, type: "all" }, {
                signal: controller.signal,
                onProgress: (page, pages) => { get("period-status").textContent = `读取时间概览 ${page}/${pages} 页…`; },
            });
            if (controller.signal.aborted) return;
            state.periods = flattenTransactions(groups, periodStart, periodEnd, timeZone);
            updateCurrencies(); renderPeriodCards();
            get("period-status").textContent = "按当前日期统计，独立于上方日期范围 · 本周为周日至周六";
        } catch (error) {
            if (controller.signal.aborted) return;
            state.periods = null;
            showError("period-error", errorMessage(error));
            get("period-status").textContent = "时间概览加载失败 · 点击顶部刷新重试";
        } finally {
            if (!controller.signal.aborted) get("period-grid").setAttribute("aria-busy", "false");
        }
    }

    async function loadDashboard() {
        state.monthlyController?.abort(); state.heatController?.abort();
        const controller = new AbortController(); state.monthlyController = controller;
        const generation = ++state.generation;
        state.month = null; state.accounts = null; state.monthError = null; state.accountError = null;
        for (const id of ["expense", "income", "surplus", "assets", "debts", "net"]) get(id).textContent = "—";
        for (const id of ["ranking-list", "calendar-days", "trend-chart"]) empty(get(id), "正在加载…");
        showError("month-error", null); showError("account-error", null);
        get("grid").setAttribute("aria-busy", "true");
        root.querySelector('[data-action="refresh"]').disabled = true;
        status("正在读取账本…");
        void loadPeriodCards();
        try {
            dayRange(start, end);
            const options = { signal: controller.signal };
            const results = await Promise.allSettled([
                loadPages("api/v1/transactions", { start, end, type: "all" }, { ...options, onProgress: (page, pages) => status(`读取当前范围交易 ${page}/${pages} 页…`) }),
                Promise.all([
                    loadPages("api/v1/accounts", { type: "asset", date: assetDate }, options),
                    loadPages("api/v1/accounts", { type: "liabilities", date: assetDate }, options),
                ]),
            ]);
            if (generation !== state.generation || controller.signal.aborted) return;
            try {
                if (results[0].status === "rejected") throw results[0].reason;
                state.month = flattenTransactions(results[0].value, start, end, timeZone);
                updateCurrencies(); renderMonth();
            } catch (error) {
                state.month = null; state.monthError = errorMessage(error);
                for (const id of ["expense", "income", "surplus"]) get(id).textContent = "—";
                showError("month-error", state.monthError);
                for (const id of ["ranking-list", "calendar-days", "trend-chart"]) empty(get(id), "当前范围数据读取失败，请刷新重试");
            }
            try {
                if (results[1].status === "rejected") throw results[1].reason;
                state.accounts = aggregateAccounts(results[1].value.flat());
                updateCurrencies(); renderAccounts();
            } catch (error) {
                state.accounts = null; state.accountError = errorMessage(error);
                get("account-info").textContent = "账户余额读取失败";
                showError("account-error", state.accountError);
            }
            const failure = state.monthError || state.accountError;
            const updated = new Intl.DateTimeFormat("zh-CN", { timeZone, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
            status(failure ? "部分数据未加载 · " + failure : `已更新 ${updated} · ${state.month.rows.length} 条当期交易明细`, Boolean(failure));
        } catch (error) {
            if (generation !== state.generation || controller.signal.aborted) return;
            status(errorMessage(error), true);
            for (const id of ["ranking-list", "calendar-days", "trend-chart"]) empty(get(id), "请选择一个月份后重试");
        } finally {
            if (generation === state.generation) {
                get("grid").setAttribute("aria-busy", "false");
                root.querySelector('[data-action="refresh"]').disabled = false;
            }
        }
        if (!controller.signal.aborted) void loadHeatmap();
    }

    function submitRange(range) {
        const form = element("form"); form.method = "POST"; form.action = root.dataset.daterangeUrl;
        for (const [name, value] of Object.entries({ start: range.start, end: range.end, redirect: "true", _token: document.querySelector('meta[name="csrf-token"]')?.content || "" })) {
            const input = element("input"); input.type = "hidden"; input.name = name; input.value = value; form.append(input);
        }
        root.append(form); form.submit();
    }

    function submitMonth(month) {
        try {
            submitRange(monthRange(month));
        } catch (error) { status(errorMessage(error), true); }
    }

    get("month").addEventListener("change", (event) => submitMonth(event.target.value));
    for (const [action, offset] of [["previous", -1], ["next", 1]]) root.querySelector(`[data-action="${action}"]`).addEventListener("click", () => {
        const date = new Date(start.slice(0, 7) + "-01T12:00:00Z"); date.setUTCMonth(date.getUTCMonth() + offset);
        submitMonth(date.toISOString().slice(0, 7));
    });
    get("currency").addEventListener("change", (event) => {
        state.currency = event.target.value; state.decimals = currencies.get(state.currency).decimals;
        renderAccounts(); renderMonth(); renderPeriodCards();
    });
    root.querySelector('[data-action="refresh"]').addEventListener("click", () => void loadDashboard());
    root.querySelector('[data-action="privacy"]').addEventListener("click", () => {
        if (state.nativeHidden) { status("顶部导航已开启隐藏金额，请先关闭顶部隐藏模式。"); return; }
        state.hidden = !state.hidden; renderPrivacy();
    });
    root.querySelector('[data-action="close-dialog"]').addEventListener("click", () => get("day-dialog").close());
    get("day-dialog").addEventListener("click", (event) => { if (event.target === get("day-dialog")) { const box = event.target.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) event.target.close(); } });
    root.querySelectorAll("[data-ranking]").forEach((button) => button.addEventListener("click", () => { state.ranking = button.dataset.ranking; renderMonth(); }));
    root.querySelectorAll("[data-trend]").forEach((button) => button.addEventListener("click", () => { state.trend = button.dataset.trend; renderMonth(); }));
    get("period").textContent = start.slice(0, 7) === end.slice(0, 7) ? String(Number(start.slice(5, 7))) + "月" : "当期";
    function chineseDate(day, withYear = false) {
        const [year, month, date] = day.split("-").map(Number);
        return `${withYear ? year + "年" : ""}${month}月${date}日`;
    }
    if (get("period-grid")) {
        for (const [key, range] of Object.entries(periodRanges)) {
            const crossYear = range.start.slice(0, 4) !== range.end.slice(0, 4);
            get(`period-${key}-range`).textContent = key === "today" ? chineseDate(today, true) : key === "year" ? today.slice(0, 4) + "年" : `${chineseDate(range.start, crossYear)} — ${chineseDate(range.end, crossYear)}`;
        }
    }
    root.querySelectorAll("[data-period-open]").forEach((button) => button.addEventListener("click", () => submitRange(periodRanges[button.dataset.periodOpen])));

    let connected = false;
    function connectNativeStore() {
        if (connected || !window.store?.observe) return;
        connected = true;
        state.nativeHidden = window.store.get("anonymous") === true;
        window.store.observe("anonymous", (value) => { state.nativeHidden = value === true; renderPrivacy(); });
        renderPrivacy();
    }
    document.addEventListener("firefly-iii-bootstrapped", connectNativeStore);
    if (window.bootstrapped) connectNativeStore();
    renderPrivacy();
    void loadDashboard();
    window.addEventListener("pagehide", () => { state.monthlyController?.abort(); state.heatController?.abort(); state.periodController?.abort(); }, { once: true });
}

export { parseAmount, formatAmount, dateKey, dayRange, monthRange, currentPeriodRanges, aggregatePeriodTotals, flattenTransactions, aggregateTransactions, aggregateAccounts, loadPages };

if (typeof document !== "undefined") {
    const root = document.getElementById("custom-dashboard");
    if (root) startDashboard(root);
}
