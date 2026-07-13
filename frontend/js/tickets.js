// Ticket issuance, redemption, transaction history, and live phase-awareness for the Tickets (teller) terminal

const PHASE_STEPS = ["BETTING", "COCKFIGHT", "REDEEMING", "CLOSED"];
let CURRENT_PHASE = null;
let CURRENT_ROUND = 0;
let HISTORY_ALL_ROUNDS = false;
let HISTORY_SEARCH = "";
let historySearchDebounce = null;

function switchTab(tabId) {
    document.querySelectorAll(".tab-content").forEach(el => el.classList.add("hidden"));
    document.getElementById(tabId).classList.remove("hidden");
    document.querySelectorAll(".tab-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tabId));
    if (tabId === "history-tab") fetchHistory();
}

function calculateLiveTax() {
    const amt = parseFloat(document.getElementById("bet-amount").value) || 0;
    const tax = amt * 0.15;
    const net = amt - tax;
    document.getElementById("tax-preview").innerText = `₱${tax.toFixed(2)}`;
    document.getElementById("net-preview").innerText = `₱${net.toFixed(2)}`;
}

function renderPhaseRail(phase, round) {
    document.getElementById("round-tag").innerText = `Round #${round}`;
    PHASE_STEPS.forEach((step, i) => {
        const el = document.getElementById(`rail-${step}`);
        el.classList.remove("active", "done");
        if (step === phase) el.classList.add("active");
        else if (PHASE_STEPS.indexOf(phase) > i) el.classList.add("done");
    });
}

function applyPhaseGating(phase) {
    const ticketPanel = document.getElementById("ticket-panel");
    const redeemPanel = document.getElementById("redeem-panel");
    const ticketSubmit = document.getElementById("ticket-submit");
    const redeemSubmit = document.getElementById("redeem-submit");

    const bettingOpen = phase === "BETTING";
    const redeemingOpen = phase === "REDEEMING";

    ticketSubmit.disabled = !bettingOpen;
    redeemSubmit.disabled = !redeemingOpen;

    ticketPanel.classList.toggle("panel-disabled", !bettingOpen);
    redeemPanel.classList.toggle("panel-disabled", !redeemingOpen);

    document.getElementById("ticket-hint").innerText = bettingOpen
        ? "Ticket sales are open for the current round."
        : `Ticket sales are closed. Current phase: ${phase}.`;

    document.getElementById("redeem-hint").innerText = redeemingOpen
        ? "Scan or type a winning barcode to pay out."
        : `Redemptions are closed. Current phase: ${phase}.`;
}

async function pollPhase() {
    try {
        const response = await authFetch("/status/phase");
        if (!response.ok) return;
        const data = await response.json();
        if (data.phase !== CURRENT_PHASE) {
            CURRENT_PHASE = data.phase;
            applyPhaseGating(data.phase);
        }
        CURRENT_ROUND = data.fight_round;
        renderPhaseRail(data.phase, data.fight_round);
    } catch (err) {
        console.error("Phase polling failed:", err);
    }
}

document.getElementById("bet-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const checkedRadio = document.querySelector('input[name="bet_type"]:checked');
    if (!checkedRadio) return alert("Select a betting side.");

    const amount = parseFloat(document.getElementById("bet-amount").value);
    if (!amount || amount <= 0) return alert("Enter a valid amount.");

    const tax = amount * 0.15;
    const net = amount - tax;

    const confirmed = await confirmAction({
        title: "Confirm new ticket",
        message: "Double-check the side and amount before printing — this cannot be undone.",
        details: [
            { label: "Side", value: checkedRadio.value },
            { label: "Gross amount", value: `₱${amount.toFixed(2)}` },
            { label: "Tax withheld (15%)", value: `₱${tax.toFixed(2)}` },
            { label: "Net stake", value: `₱${net.toFixed(2)}` },
        ],
        confirmLabel: "Print ticket",
    });
    if (!confirmed) return;

    const payload = { bet_type: checkedRadio.value, amount };

    try {
        const response = await authFetch("/tickets", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Failed to create ticket.");

        document.getElementById("r-id").innerText = data.transaction_id;
        document.getElementById("r-round").innerText = `#${data.fight_round}`;
        document.getElementById("r-type").innerText = data.bet_type;
        document.getElementById("r-gross").innerText = `₱${data.gross_amount.toFixed(2)}`;
        document.getElementById("r-tax").innerText = `₱${data.tax_deducted.toFixed(2)}`;
        document.getElementById("r-net").innerText = `₱${data.net_amount.toFixed(2)}`;
        document.getElementById("r-date").innerText = new Date(data.created_at).toLocaleString();
        document.getElementById("receipt-barcode").src = `data:image/png;base64,${data.barcode_base64}`;

        document.getElementById("receipt-container").classList.remove("hidden");
        document.getElementById("bet-form").reset();
        calculateLiveTax();
        showToast(`Ticket ${data.transaction_id} issued — ₱${data.net_amount.toFixed(2)} staked on ${data.bet_type}.`, "success");
    } catch (err) {
        showToast(err.message, "error");
    }
});

document.getElementById("redeem-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const ref = document.getElementById("scanner-input").value.trim();
    if (!ref) return;
    const resultDiv = document.getElementById("redeem-result");
    resultDiv.className = "banner hidden";

    const confirmed = await confirmAction({
        title: "Confirm payout",
        message: "Confirm this is the correct ticket before dispensing any cash.",
        details: [{ label: "Barcode / Transaction ID", value: ref }],
        confirmLabel: "Validate & pay out",
    });
    if (!confirmed) return;

    try {
        const response = await authFetch(`/tickets/redeem/${encodeURIComponent(ref)}`, { method: "POST" });
        const data = await response.json();
        if (!response.ok) {
            resultDiv.innerText = data.detail || "Redemption error.";
            resultDiv.classList.add("banner", "error");
            resultDiv.classList.remove("hidden");
            showToast(data.detail || "Redemption failed.", "error");
            return;
        }

        resultDiv.innerText = `${data.payout_status} — ₱${data.payout_amount.toFixed(2)}. ${data.message}`;
        resultDiv.classList.add("banner", "success");
        resultDiv.classList.remove("hidden");
        showToast(`Ticket ${data.transaction_id} paid out — ₱${data.payout_amount.toFixed(2)}.`, "success");

        document.getElementById("scanner-input").value = "";
        document.getElementById("scanner-input").focus();
    } catch (err) {
        resultDiv.innerText = "Could not reach the server.";
        resultDiv.classList.add("banner", "error");
        resultDiv.classList.remove("hidden");
        showToast("Could not reach the server.", "error");
    }
});

function historyStatusTag(tx) {
    if (tx.is_redeemed) return `<span class="tag paid">${tx.status === "REFUNDED" ? "REFUNDED" : "PAID"}</span>`;
    if (tx.status === "WON") return `<span class="tag won">WON</span>`;
    if (tx.status === "LOST") return `<span class="tag lost">LOST</span>`;
    if (tx.status === "REFUNDED") return `<span class="tag pending">REFUND DUE</span>`;
    return `<span class="tag pending">PENDING</span>`;
}

async function openTicketDetail(ticketId) {
    try {
        const response = await authFetch(`/tickets/${encodeURIComponent(ticketId)}`);
        if (!response.ok) { showToast("Could not load that ticket.", "error"); return; }
        const ticket = await response.json();
        showTicketDetail(ticket);
    } catch (err) {
        showToast("Could not load that ticket.", "error");
    }
}

async function fetchHistory() {
    try {
        const params = new URLSearchParams();
        if (HISTORY_ALL_ROUNDS) params.set("all_rounds", "true");
        if (HISTORY_SEARCH) params.set("search", HISTORY_SEARCH);
        const response = await authFetch(`/tickets?${params.toString()}`);
        if (!response.ok) return;
        const data = await response.json();

        const tbody = document.getElementById("history-body");
        tbody.innerHTML = "";

        if (data.transactions.length === 0) {
            document.getElementById("history-empty").classList.remove("hidden");
            return;
        }
        document.getElementById("history-empty").classList.add("hidden");

        let lastDateLabel = null;
        data.transactions.forEach(tx => {
            const created = new Date(tx.created_at);
            const dateLabel = created.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });

            if (HISTORY_ALL_ROUNDS && dateLabel !== lastDateLabel) {
                const groupRow = document.createElement("tr");
                groupRow.className = "date-group-row";
                groupRow.innerHTML = `<td colspan="6">${dateLabel}</td>`;
                tbody.appendChild(groupRow);
                lastDateLabel = dateLabel;
            }

            const tr = document.createElement("tr");
            tr.className = "clickable-row";
            tr.addEventListener("click", () => openTicketDetail(tx.id));
            tr.innerHTML = `
                <td class="mono">${tx.id}</td>
                <td>${created.toLocaleString()}</td>
                <td class="mono">#${tx.fight_round}</td>
                <td><strong>${tx.bet_type}</strong></td>
                <td class="mono">₱${tx.net_amount.toFixed(2)}</td>
                <td>${historyStatusTag(tx)}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error("History fetch failed:", err);
    }
}

function initTicketsDashboard() {
    if (!requireRole("TELLER")) return;
    document.getElementById("user-display").innerText = USERNAME;
    calculateLiveTax();
    pollPhase();
    setInterval(pollPhase, 4000);

    document.getElementById("history-toggle-rounds-btn").addEventListener("click", () => {
        HISTORY_ALL_ROUNDS = !HISTORY_ALL_ROUNDS;
        document.getElementById("history-toggle-rounds-btn").innerText = HISTORY_ALL_ROUNDS ? "Show current round only" : "View all rounds";
        fetchHistory();
    });

    document.getElementById("history-search").addEventListener("input", (e) => {
        clearTimeout(historySearchDebounce);
        historySearchDebounce = setTimeout(() => {
            HISTORY_SEARCH = e.target.value.trim();
            fetchHistory();
        }, 300);
    });
}

initTicketsDashboard();
