// Global System Engine Core Context Variables
const API_BASE = "http://127.0.0.1:8000/api/v1";

// sessionStorage (not localStorage) is scoped to a single browser tab, not the
// whole browser. That's what stops an admin session in one tab and a teller
// session in another tab from overwriting each other's stored role/token,
// which was the root cause of "the wrong dashboard shows up after refresh."
let TOKEN = sessionStorage.getItem("token") || "";
let USER_ROLE = sessionStorage.getItem("role") || "";
let USERNAME = sessionStorage.getItem("username") || "";

/**
 * Guards a dashboard page: if there's no token, or the stored role doesn't
 * match the role this page is built for, send the visitor to the login page.
 */
function requireRole(expectedRole) {
    if (!TOKEN || USER_ROLE !== expectedRole) {
        window.location.replace("login.html");
        return false;
    }
    return true;
}

/** Wrapper around fetch() that attaches the bearer token and handles 401s uniformly. */
async function authFetch(path, options = {}) {
    const headers = Object.assign({}, options.headers || {}, {
        "Authorization": `Bearer ${TOKEN}`
    });
    const response = await fetch(`${API_BASE}${path}`, Object.assign({}, options, { headers }));
    if (response.status === 401) {
        logout();
        throw new Error("Session expired. Please log in again.");
    }
    return response;
}

async function logout() {
    // Record the LOGOUT event before wiping the session. Uses a raw fetch
    // (not authFetch) so a 401 here can't trigger logout() calling itself.
    if (TOKEN) {
        try {
            await fetch(`${API_BASE}/auth/logout`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${TOKEN}` }
            });
        } catch (err) {
            // Still log the user out locally even if this call fails (e.g. server down).
        }
    }
    sessionStorage.clear();
    window.location.replace("login.html");
}

/* ============================================================
   Shared UI: confirmation modal + toast notifications
   Every page that uses these must include a <div id="modal-root"></div>
   and <div id="toast-root"></div> somewhere in its body.
   ============================================================ */

/**
 * Shows a visual confirmation modal and resolves true/false based on the
 * user's choice. This replaces native confirm() popups so the person sees
 * exactly what they're about to do (amounts, sides, barcodes spelled out)
 * before a second, deliberate click commits it — a real two-step check
 * against misinput, not just a browser dialog they can reflexively dismiss.
 */
function confirmAction({ title, message, details = [], confirmLabel = "Confirm", danger = false }) {
    return new Promise((resolve) => {
        const root = document.getElementById("modal-root");

        const detailRows = details.map(d =>
            `<div class="modal-detail-row"><span>${d.label}</span><span class="val">${d.value}</span></div>`
        ).join("");

        root.innerHTML = `
            <div class="modal-backdrop">
              <div class="modal-card">
                <div class="modal-title">${title}</div>
                <div class="modal-message">${message}</div>
                ${detailRows ? `<div class="modal-details">${detailRows}</div>` : ""}
                <div class="modal-actions">
                  <button class="btn btn-outline" id="modal-cancel-btn" type="button">Cancel</button>
                  <button class="btn ${danger ? "btn-danger" : "btn-primary"}" id="modal-confirm-btn" type="button">${confirmLabel}</button>
                </div>
              </div>
            </div>
        `;
        root.classList.remove("hidden");

        const close = (result) => {
            root.classList.add("hidden");
            root.innerHTML = "";
            resolve(result);
        };

        document.getElementById("modal-cancel-btn").addEventListener("click", () => close(false));
        document.getElementById("modal-confirm-btn").addEventListener("click", () => close(true));
        root.querySelector(".modal-backdrop").addEventListener("click", (e) => {
            if (e.target.classList.contains("modal-backdrop")) close(false);
        });
    });
}

/** Shows a short-lived success/error/info toast confirming an action completed. */
function showToast(message, type = "success", timeout = 4000) {
    const root = document.getElementById("toast-root");
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.innerText = message;
    root.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add("toast-in"));

    setTimeout(() => {
        toast.classList.remove("toast-in");
        toast.classList.add("toast-out");
        setTimeout(() => toast.remove(), 250);
    }, timeout);
}

const STATUS_LABELS = {
    PENDING: "Pending",
    WON: "Won",
    LOST: "Lost",
    REFUNDED: "Refunded",
};

/** View-only modal for inspecting a single ticket, barcode included, from a ledger/history click. */
function showTicketDetail(ticket) {
    const root = document.getElementById("modal-root");

    const paidLine = ticket.is_redeemed
        ? `<div class="modal-detail-row"><span>Paid out</span><span class="val">${new Date(ticket.redeemed_at).toLocaleString()}</span></div>`
        : `<div class="modal-detail-row"><span>Paid out</span><span class="val">Not yet</span></div>`;

    root.innerHTML = `
        <div class="modal-backdrop">
          <div class="modal-card">
            <div class="modal-title">Ticket ${ticket.transaction_id}</div>
            <div class="modal-message">Round #${ticket.fight_round} · ${new Date(ticket.created_at).toLocaleString()}</div>
            <div class="modal-details">
              <div class="modal-detail-row"><span>Side</span><span class="val">${ticket.bet_type}</span></div>
              <div class="modal-detail-row"><span>Gross</span><span class="val">₱${ticket.gross_amount.toFixed(2)}</span></div>
              <div class="modal-detail-row"><span>Tax</span><span class="val">₱${ticket.tax_amount.toFixed(2)}</span></div>
              <div class="modal-detail-row"><span>Net stake</span><span class="val">₱${ticket.net_amount.toFixed(2)}</span></div>
              <div class="modal-detail-row"><span>Status</span><span class="val">${STATUS_LABELS[ticket.status] || ticket.status}</span></div>
              <div class="modal-detail-row"><span>Payout</span><span class="val">₱${ticket.payout_amount.toFixed(2)}</span></div>
              ${paidLine}
            </div>
            <div class="receipt-barcode-wrap">
              <img src="data:image/png;base64,${ticket.barcode_base64}" alt="Ticket barcode">
              <div class="panel-hint" style="margin-top:8px;">If this barcode won't scan, the transaction ID above can be typed into the redeem form instead.</div>
            </div>
            <div class="modal-actions" style="margin-top:18px;">
              <button class="btn btn-outline" id="modal-close-btn" type="button" style="flex:1;">Close</button>
            </div>
          </div>
        </div>
    `;
    root.classList.remove("hidden");

    const close = () => { root.classList.add("hidden"); root.innerHTML = ""; };
    document.getElementById("modal-close-btn").addEventListener("click", close);
    root.querySelector(".modal-backdrop").addEventListener("click", (e) => {
        if (e.target.classList.contains("modal-backdrop")) close();
    });
}
