// System round/phase transitions (with an explicit "start new round" step and
// a full "overall close" reset), fight resolution, round snapshot stats,
// ledger, income reports, team accounts, and login activity for the Admin console.

const PHASE_STEPS = ["BETTING", "COCKFIGHT", "REDEEMING", "CLOSED"];
const PHASE_LABELS = { BETTING: "Betting", COCKFIGHT: "Cockfight", REDEEMING: "Redeeming", CLOSED: "Closed" };

// Legal next phase(s) from each phase — mirrors the backend's
// FightStateService.ALLOWED_TRANSITIONS. Used purely to disable buttons
// that would be rejected anyway, so a misinput (e.g. clicking "Start
// cockfight" while still in Redeeming) is caught before the request is
// even sent instead of surfacing only as a server error.
const ALLOWED_NEXT_PHASE = {
    CLOSED: ["BETTING"],
    BETTING: ["COCKFIGHT"],
    COCKFIGHT: ["REDEEMING"],
    REDEEMING: ["CLOSED"],
};

let CURRENT_PHASE = null;
let CURRENT_ROUND = 0;
let ROUND_READY = false;
let VIEWING_ALL_ROUNDS = false;
let LEDGER_SEARCH = "";
let ledgerSearchDebounce = null;
let ACTIVITY_SEARCH = "";
let activitySearchDebounce = null;

/* ---------------- Tab switching ---------------- */

function switchAdminTab(tabId) {
    document.querySelectorAll(".tab-content").forEach(el => el.classList.add("hidden"));
    document.getElementById(tabId).classList.remove("hidden");
    document.querySelectorAll(".header-tab-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.tab === tabId));

    if (tabId === "tab-reports") fetchDailyReport();
    if (tabId === "tab-activity") fetchActivityLog();
    if (tabId === "tab-accounts") fetchUsers();
}

/* ---------------- Fight cycle / phase controls ---------------- */

function renderPhaseRail(phase, round) {
    document.getElementById("round-tag").innerText = `Round #${round}`;
    PHASE_STEPS.forEach((step, i) => {
        const el = document.getElementById(`rail-${step}`);
        el.classList.remove("active", "done");
        if (step === phase) el.classList.add("active");
        else if (PHASE_STEPS.indexOf(phase) > i) el.classList.add("done");
    });
}

function applyPhaseUI(phase, roundReady) {
    document.getElementById("resolve-panel").classList.toggle("hidden", phase !== "COCKFIGHT");

    // Only the button matching the current phase gets colored — the rest stay plain,
    // so it's unambiguous at a glance which phase is actually active.
    // On top of that, every button that is NOT the legal next step from the
    // current phase is disabled outright — this is what stops an admin from
    // e.g. starting a cockfight while still in Redeeming by mis-click.
    const allowedNext = ALLOWED_NEXT_PHASE[phase] || [];
    document.querySelectorAll(".cmd-btn[data-phase]").forEach(btn => {
        const isActive = btn.dataset.phase === phase;
        btn.classList.toggle("is-active", isActive);
        const isLegalNext = allowedNext.includes(btn.dataset.phase);
        // Opening BETTING additionally requires a round to have been created.
        const blockedByRoundReady = btn.dataset.phase === "BETTING" && !roundReady;
        btn.disabled = !isLegalNext || blockedByRoundReady;
    });

    const newRoundBtn = document.getElementById("new-round-btn");
    const roundHint = document.getElementById("round-control-hint");
    const canStartRound = phase === "CLOSED" && !roundReady;
    newRoundBtn.disabled = !canStartRound;
    if (phase !== "CLOSED") {
        roundHint.innerText = `Round control is only available while the system is Closed. Current phase: ${PHASE_LABELS[phase] || phase}.`;
    } else if (roundReady) {
        roundHint.innerText = `Round #${CURRENT_ROUND} is ready — open betting when you're set.`;
    } else {
        roundHint.innerText = "Start a new round before betting can open. This no longer happens automatically.";
    }

    const resetBtn = document.getElementById("reset-system-btn");
    resetBtn.disabled = phase !== "CLOSED";
}

function renderRoundStats(summary) {
    document.getElementById("stat-round").innerText = `#${summary.fight_round}`;
    document.getElementById("stat-count").innerText = summary.ticket_count;
    document.getElementById("stat-net").innerText = `₱${summary.total_net.toFixed(2)}`;
    document.getElementById("stat-gross").innerText = `₱${summary.total_gross.toFixed(2)}`;
}

async function createNewRound() {
    const confirmed = await confirmAction({
        title: "Start a new round",
        message: "This begins a brand new fight round/queue. You'll still need to open betting separately once you're ready.",
        details: [{ label: "Next round number", value: `#${CURRENT_ROUND + 1}` }],
        confirmLabel: "Start new round",
    });
    if (!confirmed) return;

    try {
        const response = await authFetch("/admin/round/new", { method: "POST" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Could not start a new round.");
        CURRENT_ROUND = data.fight_round;
        ROUND_READY = true;
        renderPhaseRail(CURRENT_PHASE, CURRENT_ROUND);
        applyPhaseUI(CURRENT_PHASE, ROUND_READY);
        showToast(`Round #${CURRENT_ROUND} created. Open betting when ready.`, "success");
    } catch (err) {
        showToast(err.message, "error");
    }
}

async function resetSystem() {
    const confirmed = await confirmAction({
        title: "Confirm overall close",
        message: "This resets the round counter and phase all the way back to idle, ready for a brand new cockfight event. Ticket and activity history are kept — only the live phase/round state is cleared.",
        details: [
            { label: "Current round", value: `#${CURRENT_ROUND}` },
            { label: "After reset", value: "Round #0, Closed" },
        ],
        confirmLabel: "Overall close & reset",
        danger: true,
    });
    if (!confirmed) return;

    try {
        const response = await authFetch("/admin/system/reset", { method: "POST" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Reset failed.");
        CURRENT_PHASE = data.current_phase;
        CURRENT_ROUND = data.fight_round;
        ROUND_READY = false;
        renderPhaseRail(CURRENT_PHASE, CURRENT_ROUND);
        applyPhaseUI(CURRENT_PHASE, ROUND_READY);
        fetchLedger();
        showToast("System fully reset — ready for a new cockfight event.", "success");
    } catch (err) {
        showToast(err.message, "error");
    }
}

async function setPhase(phaseName) {
    const confirmed = await confirmAction({
        title: "Confirm phase change",
        message: phaseName === "BETTING"
            ? "This opens betting for the current round. All new tickets will be tagged to this round."
            : "This changes what tellers are currently allowed to do system-wide.",
        details: [
            { label: "Current phase", value: PHASE_LABELS[CURRENT_PHASE] || "—" },
            { label: "New phase", value: PHASE_LABELS[phaseName] },
        ],
        confirmLabel: `Set to ${PHASE_LABELS[phaseName]}`,
    });
    if (!confirmed) return;

    try {
        const response = await authFetch(`/admin/phase/${phaseName}`, { method: "POST" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Phase change failed.");
        CURRENT_PHASE = data.current_phase;
        CURRENT_ROUND = data.fight_round;
        if (CURRENT_PHASE === "BETTING") ROUND_READY = false;
        renderPhaseRail(CURRENT_PHASE, CURRENT_ROUND);
        applyPhaseUI(CURRENT_PHASE, ROUND_READY);
        fetchLedger();
        showToast(`Phase set to ${PHASE_LABELS[CURRENT_PHASE]} (Round #${CURRENT_ROUND}).`, "success");
    } catch (err) {
        showToast(err.message, "error");
    }
}

async function declareResult(winningSide) {
    const isDraw = winningSide === "DRAW";
    const confirmed = await confirmAction({
        title: isDraw ? "Confirm no decision" : "Confirm fight result",
        message: isDraw
            ? "Every pending ticket in this round will be refunded in full. No side wins. This cannot be undone."
            : "This locks every pending ticket in the current round and calculates payouts. This cannot be undone.",
        details: [
            { label: "Round", value: `#${CURRENT_ROUND}` },
            { label: "Declared outcome", value: isDraw ? "NO DECISION / DRAW" : `${winningSide} WINS` },
        ],
        confirmLabel: isDraw ? "Confirm refund" : "Declare winner",
        danger: true,
    });
    if (!confirmed) return;

    try {
        const response = await authFetch(`/admin/fight-result?winning_bet_type=${winningSide}`, { method: "POST" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Resolution failed.");

        const summary = document.getElementById("resolve-summary");
        if (data.outcome === "REFUND") {
            summary.innerHTML = `
                <div class="receipt-row"><span>Outcome</span><span class="val">NO DECISION / DRAW</span></div>
                <div class="receipt-row"><span>Total refunded</span><span class="val">₱${data.total_net_pool.toFixed(2)}</span></div>
            `;
        } else {
            summary.innerHTML = `
                <div class="receipt-row"><span>Winning side</span><span class="val">${winningSide}</span></div>
                <div class="receipt-row"><span>Total net pool</span><span class="val">₱${data.total_net_pool.toFixed(2)}</span></div>
                <div class="receipt-row"><span>Winning side pool</span><span class="val">₱${data.winning_net_pool.toFixed(2)}</span></div>
                <div class="receipt-row"><span>Payout odds</span><span class="val">${data.payout_ratio}x</span></div>
            `;
        }
        summary.classList.remove("hidden");

        CURRENT_PHASE = "REDEEMING";
        renderPhaseRail(CURRENT_PHASE, CURRENT_ROUND);
        applyPhaseUI(CURRENT_PHASE, ROUND_READY);
        fetchLedger();
        showToast(
            data.outcome === "REFUND"
                ? `Round #${CURRENT_ROUND} refunded in full.`
                : `Round #${CURRENT_ROUND} resolved — ${winningSide} wins at ${data.payout_ratio}x.`,
            "success"
        );
    } catch (err) {
        showToast(err.message, "error");
    }
}

/* ---------------- Ledger ---------------- */

function ledgerStatusTag(tx) {
    if (tx.is_redeemed) return `<span class="tag paid">${tx.status === "REFUNDED" ? "REFUNDED" : "PAID"}</span>`;
    if (tx.status === "WON") return `<span class="tag won">WON</span>`;
    if (tx.status === "LOST") return `<span class="tag lost">LOST</span>`;
    if (tx.status === "REFUNDED") return `<span class="tag pending">REFUND DUE</span>`;
    return `<span class="tag pending">PENDING</span>`;
}

async function openTicketDetail(ticketId) {
    try {
        const response = await authFetch(`/admin/tickets/${encodeURIComponent(ticketId)}`);
        if (!response.ok) { showToast("Could not load that ticket.", "error"); return; }
        const ticket = await response.json();
        showTicketDetail(ticket);
    } catch (err) {
        showToast("Could not load that ticket.", "error");
    }
}

async function fetchLedger() {
    try {
        const params = new URLSearchParams();
        if (VIEWING_ALL_ROUNDS) params.set("all_rounds", "true");
        if (LEDGER_SEARCH) params.set("search", LEDGER_SEARCH);
        const response = await authFetch(`/admin/monitor/tellers?${params.toString()}`);
        if (!response.ok) return;
        const data = await response.json();
        CURRENT_ROUND = data.current_round;

        renderRoundStats(data.round_summary);

        document.getElementById("ledger-round-label").innerText = VIEWING_ALL_ROUNDS
            ? "All rounds"
            : `Round #${data.current_round}`;

        const tbody = document.getElementById("ledger-body");
        tbody.innerHTML = "";

        if (data.recent_transactions.length === 0) {
            document.getElementById("ledger-empty").classList.remove("hidden");
            return;
        }
        document.getElementById("ledger-empty").classList.add("hidden");

        let lastDateLabel = null;
        data.recent_transactions.forEach(tx => {
            const created = new Date(tx.created_at);
            const dateLabel = created.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });

            if (VIEWING_ALL_ROUNDS && dateLabel !== lastDateLabel) {
                const groupRow = document.createElement("tr");
                groupRow.className = "date-group-row";
                groupRow.innerHTML = `<td colspan="9">${dateLabel}</td>`;
                tbody.appendChild(groupRow);
                lastDateLabel = dateLabel;
            }

            const tr = document.createElement("tr");
            tr.className = "clickable-row";
            tr.addEventListener("click", () => openTicketDetail(tx.id));

            let payoutCell = `₱${tx.net_amount.toFixed(2)}`;
            if (tx.status === "WON" && tx.payout_amount > 0) {
                payoutCell = `₱${tx.payout_amount.toFixed(2)} <span class="mono" style="color:var(--text-faint)">(${tx.payout_ratio}x)</span>`;
            }
            tr.innerHTML = `
                <td class="mono">${tx.id}</td>
                <td>${created.toLocaleString()}</td>
                <td class="mono">#${tx.fight_round}</td>
                <td>ID-${tx.teller_id}</td>
                <td><strong>${tx.bet_type}</strong></td>
                <td class="mono">₱${tx.gross_amount.toFixed(2)}</td>
                <td class="mono">₱${tx.tax_amount.toFixed(2)}</td>
                <td class="mono">${payoutCell}</td>
                <td>${ledgerStatusTag(tx)}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error("Ledger fetch failed:", err);
    }
}

function toggleRoundView() {
    VIEWING_ALL_ROUNDS = !VIEWING_ALL_ROUNDS;
    document.getElementById("toggle-rounds-btn").innerText = VIEWING_ALL_ROUNDS ? "Show current round only" : "View all rounds";
    fetchLedger();
}

/* ---------------- Income reports ---------------- */

async function fetchDailyReport() {
    try {
        const response = await authFetch("/admin/reports/daily-income");
        if (!response.ok) return;
        const data = await response.json();
        const tbody = document.getElementById("reports-body");
        tbody.innerHTML = "";

        if (data.days.length === 0) {
            document.getElementById("reports-empty").classList.remove("hidden");
            return;
        }
        document.getElementById("reports-empty").classList.add("hidden");

        data.days.forEach(d => {
            const tr = document.createElement("tr");
            const dateLabel = new Date(d.date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
            tr.innerHTML = `
                <td><strong>${dateLabel}</strong></td>
                <td class="mono">${d.ticket_count}</td>
                <td class="mono">₱${d.total_gross.toFixed(2)}</td>
                <td class="mono" style="color:var(--rose)">₱${d.total_tax.toFixed(2)}</td>
                <td class="mono">₱${d.total_net.toFixed(2)}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error("Daily report fetch failed:", err);
    }
}

/* ---------------- Team accounts ---------------- */

async function fetchUsers() {
    try {
        const response = await authFetch("/admin/accounts");
        if (!response.ok) return;
        const users = await response.json();
        const tbody = document.getElementById("users-body");
        tbody.innerHTML = "";
        users.forEach(u => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td class="mono">${u.id}</td>
                <td><strong>${u.username}</strong></td>
                <td>${u.role}</td>
                <td>${u.is_active ? '<span class="tag won">ACTIVE</span>' : '<span class="tag lost">DISABLED</span>'}</td>
                <td><button class="btn-outline small" data-user-id="${u.id}" data-username="${u.username}" data-active="${u.is_active}">${u.is_active ? "Deactivate" : "Reactivate"}</button></td>
            `;
            tbody.appendChild(tr);
        });
        tbody.querySelectorAll("button[data-user-id]").forEach(btn => {
            btn.addEventListener("click", () => toggleUserActive(btn.dataset.userId, btn.dataset.username, btn.dataset.active === "true"));
        });
    } catch (err) {
        console.error("User list fetch failed:", err);
    }
}

async function handleCreateUser(e) {
    e.preventDefault();
    const username = document.getElementById("new-username").value.trim();
    const password = document.getElementById("new-password").value;
    const role = document.querySelector('input[name="new-role"]:checked').value;

    if (username.length < 3) return showToast("Username must be at least 3 characters.", "error");
    if (password.length < 8) return showToast("Password must be at least 8 characters.", "error");

    const confirmed = await confirmAction({
        title: "Confirm new account",
        message: "Double-check the username and role before creating this login.",
        details: [
            { label: "Username", value: username },
            { label: "Role", value: role },
        ],
        confirmLabel: "Create account",
    });
    if (!confirmed) return;

    try {
        const response = await authFetch("/admin/accounts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password, role }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Failed to create account.");

        showToast(`Account "${data.username}" (${data.role}) created.`, "success");
        document.getElementById("create-user-form").reset();
        fetchUsers();
    } catch (err) {
        showToast(err.message, "error");
    }
}

async function toggleUserActive(userId, username, currentlyActive) {
    const confirmed = await confirmAction({
        title: currentlyActive ? "Confirm deactivation" : "Confirm reactivation",
        message: currentlyActive
            ? "This account will no longer be able to log in. Their transaction history is kept."
            : "This account will be able to log in again.",
        details: [{ label: "Username", value: username }],
        confirmLabel: currentlyActive ? "Deactivate" : "Reactivate",
        danger: currentlyActive,
    });
    if (!confirmed) return;

    try {
        const response = await authFetch(`/admin/accounts/${userId}/toggle-active`, { method: "PATCH" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.detail || "Action failed.");
        showToast(`"${data.username}" is now ${data.is_active ? "active" : "disabled"}.`, "success");
        fetchUsers();
    } catch (err) {
        showToast(err.message, "error");
    }
}

/* ---------------- Activity log ---------------- */

async function fetchActivityLog() {
    try {
        const params = new URLSearchParams();
        if (ACTIVITY_SEARCH) params.set("search", ACTIVITY_SEARCH);
        const response = await authFetch(`/admin/audit-logs?${params.toString()}`);
        if (!response.ok) return;
        const data = await response.json();
        const tbody = document.getElementById("activity-body");
        tbody.innerHTML = "";

        if (data.logs.length === 0) {
            document.getElementById("activity-empty").classList.remove("hidden");
            return;
        }
        document.getElementById("activity-empty").classList.add("hidden");

        data.logs.forEach(log => {
            const tr = document.createElement("tr");
            const actionTag = log.action === "LOGIN"
                ? '<span class="tag won">LOGIN</span>'
                : '<span class="tag lost">LOGOUT</span>';
            tr.innerHTML = `
                <td>${new Date(log.timestamp).toLocaleString()}</td>
                <td><strong>${log.username}</strong></td>
                <td>${log.role}</td>
                <td>${actionTag}</td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        console.error("Activity log fetch failed:", err);
    }
}

/* ---------------- Live phase polling ---------------- */

async function pollPhase() {
    try {
        const response = await authFetch("/status/phase");
        if (!response.ok) return;
        const data = await response.json();
        if (data.phase !== CURRENT_PHASE || data.fight_round !== CURRENT_ROUND || data.round_ready !== ROUND_READY) {
            CURRENT_PHASE = data.phase;
            CURRENT_ROUND = data.fight_round;
            ROUND_READY = data.round_ready;
            renderPhaseRail(CURRENT_PHASE, CURRENT_ROUND);
            applyPhaseUI(CURRENT_PHASE, ROUND_READY);
            if (!VIEWING_ALL_ROUNDS) fetchLedger();
        }
    } catch (err) {
        console.error("Phase polling failed:", err);
    }
}

/* ---------------- Init ---------------- */

function initAdminDashboard() {
    if (!requireRole("ADMIN")) return;
    document.getElementById("user-display").innerText = USERNAME;
    document.getElementById("toggle-rounds-btn").addEventListener("click", toggleRoundView);

    document.getElementById("ledger-search").addEventListener("input", (e) => {
        clearTimeout(ledgerSearchDebounce);
        ledgerSearchDebounce = setTimeout(() => {
            LEDGER_SEARCH = e.target.value.trim();
            fetchLedger();
        }, 300);
    });

    document.getElementById("activity-search").addEventListener("input", (e) => {
        clearTimeout(activitySearchDebounce);
        activitySearchDebounce = setTimeout(() => {
            ACTIVITY_SEARCH = e.target.value.trim();
            fetchActivityLog();
        }, 300);
    });

    document.getElementById("create-user-form").addEventListener("submit", handleCreateUser);

    pollPhase();
    fetchLedger();
    setInterval(pollPhase, 4000);
    setInterval(() => { if (!VIEWING_ALL_ROUNDS && !LEDGER_SEARCH) fetchLedger(); }, 8000);
}

initAdminDashboard();
