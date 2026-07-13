// Login + role-based routing to the correct dashboard file
document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorDiv = document.getElementById("login-error");
    errorDiv.classList.add("hidden");

    const submitBtn = document.getElementById("login-submit");
    submitBtn.disabled = true;
    submitBtn.innerText = "Signing in...";

    const formData = new URLSearchParams();
    formData.append("username", document.getElementById("username").value.trim());
    formData.append("password", document.getElementById("password").value);

    try {
        const response = await fetch(`${API_BASE}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: formData
        });

        if (!response.ok) throw new Error("Invalid username or password.");
        const data = await response.json();

        const payload = JSON.parse(atob(data.access_token.split('.')[1]));

        localStorage.removeItem("token"); localStorage.removeItem("role"); localStorage.removeItem("username"); // clean up any old-format session
        sessionStorage.setItem("token", data.access_token);
        sessionStorage.setItem("role", payload.role);
        sessionStorage.setItem("username", payload.sub);

        // Route straight to the dashboard file that matches this account's role.
        if (payload.role === "ADMIN") {
            window.location.replace("admin.html");
        } else {
            window.location.replace("teller.html");
        }
    } catch (err) {
        errorDiv.innerText = err.message;
        errorDiv.classList.remove("hidden");
        submitBtn.disabled = false;
        submitBtn.innerText = "Sign in";
    }
});

// If someone with a valid session lands back on login.html, send them straight in.
(function redirectIfAlreadyLoggedIn() {
    const token = sessionStorage.getItem("token");
    const role = sessionStorage.getItem("role");
    if (token && role === "ADMIN") window.location.replace("admin.html");
    else if (token && role === "TELLER") window.location.replace("teller.html");
})();
