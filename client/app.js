
"use strict";

// =====================================
// PYCHAT — TOKEN SESSION CLIENT
// 30-DAY SESSION + AUTO RESUME
// =====================================

const SERVER_URL = "wss://pychat-8gdk.onrender.com";

// Eski versiyada parol saqlangan kalit
const STORAGE_KEY = "pychat_saved_account";

// Yangi versiyada token saqlanadigan kalit
const SESSION_STORAGE_KEY = "pychat_saved_session";

let socket = null;
let username = "";
let joined = false;

let sessionToken = null;
let sessionExpiresAt = null;
let legacyCredentials = null;

let autoLoginEnabled = false;
let reconnectTimer = null;
let reconnectAttempts = 0;
let manualDisconnect = false;
let connectionInProgress = false;


// =====================================
// HTML ELEMENTS
// =====================================

const loginScreen = document.getElementById("loginScreen");
const chatScreen = document.getElementById("chatScreen");

const loginForm = document.getElementById("loginForm");
const registerForm = document.getElementById("registerForm");

const loginUsername = document.getElementById("loginUsername");
const loginPassword = document.getElementById("loginPassword");

const registerUsername = document.getElementById("registerUsername");
const registerPassword = document.getElementById("registerPassword");
const confirmPassword = document.getElementById("confirmPassword");

const loginButton = document.getElementById("loginButton");
const registerButton = document.getElementById("registerButton");

const loginError = document.getElementById("loginError");
const registerError = document.getElementById("registerError");

const showRegister = document.getElementById("showRegister");
const showLoginButton = document.getElementById("showLogin");

const authTitle = document.getElementById("authTitle");
const authSubtitle = document.getElementById("authSubtitle");

const toggleLoginPassword = document.getElementById("toggleLoginPassword");
const toggleRegisterPassword = document.getElementById("toggleRegisterPassword");

const messages = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");

const userList = document.getElementById("userList");
const userCount = document.getElementById("userCount");

const statusDot = document.getElementById("statusDot");
const connectionStatus = document.getElementById("connectionStatus");

const myUsername = document.getElementById("myUsername");
const myAvatar = document.getElementById("myAvatar");
const myAvatarImage = document.getElementById("myAvatarImage");

const leaveButton = document.getElementById("leaveButton");
const logoutButton = document.getElementById("logoutButton");

const profileMenuButton = document.getElementById("profileMenuButton");
const profileMenu = document.getElementById("profileMenu");

const changeAvatarButton = document.getElementById("changeAvatarButton");
const avatarUpload = document.getElementById("avatarUpload");

const userSearch = document.getElementById("userSearch");
const conversationList = document.getElementById("conversationList");

const chatTitle = document.getElementById("chatTitle");
const chatSubtitle = document.getElementById("chatSubtitle");


// =====================================
// CONNECTION STATUS
// =====================================

function setStatus(online, text) {
    if (statusDot) {
        statusDot.classList.toggle("online", Boolean(online));
    }

    if (connectionStatus) {
        connectionStatus.textContent = text;
    }
}

function updateSendAvailability() {
    if (sendButton) {
        sendButton.disabled = !joined;
    }

    if (messageInput) {
        messageInput.disabled = !joined;
    }
}


// =====================================
// SCREEN SWITCHING
// =====================================

function showLoginForm() {
    if (loginForm) loginForm.classList.remove("hidden");
    if (registerForm) registerForm.classList.add("hidden");

    if (authTitle) authTitle.textContent = "Welcome back";

    if (authSubtitle) {
        authSubtitle.textContent = "Sign in to continue to PyChat";
    }

    if (loginError) loginError.textContent = "";
    if (registerError) registerError.textContent = "";
}

function showRegisterForm() {
    if (loginForm) loginForm.classList.add("hidden");
    if (registerForm) registerForm.classList.remove("hidden");

    if (authTitle) authTitle.textContent = "Create account";

    if (authSubtitle) {
        authSubtitle.textContent = "Join the PyChat community";
    }

    if (loginError) loginError.textContent = "";
    if (registerError) registerError.textContent = "";
}

function showLogin() {
    if (loginScreen) loginScreen.classList.remove("hidden");
    if (chatScreen) chatScreen.classList.add("hidden");

    setStatus(false, "Offline");
    updateSendAvailability();

    if (messages) {
        messages.replaceChildren();

        const empty = document.createElement("div");
        empty.className = "empty-state";

        const icon = document.createElement("div");
        icon.className = "empty-icon";
        icon.textContent = "P";

        const title = document.createElement("h3");
        title.textContent = "Welcome to PyChat!";

        const description = document.createElement("p");
        description.textContent = "Send your first message.";

        empty.append(icon, title, description);
        messages.appendChild(empty);
    }

    if (userList) userList.replaceChildren();
    if (conversationList) conversationList.replaceChildren();

    if (userCount) userCount.textContent = "0";
}


// =====================================
// INSTANT CHAT SCREEN
// =====================================

function showChatImmediately(savedUsername) {
    username = savedUsername || username;

    if (myUsername) {
        myUsername.textContent = username;
    }

    if (myAvatar) {
        myAvatar.textContent =
            username.charAt(0).toUpperCase() || "U";
    }

    if (loginScreen) loginScreen.classList.add("hidden");
    if (chatScreen) chatScreen.classList.remove("hidden");

    if (chatTitle) {
        chatTitle.textContent = "General Chat";
    }

    if (chatSubtitle) {
        chatSubtitle.textContent = "Connecting to PyChat...";
    }

    setStatus(false, "Connecting...");
    updateSendAvailability();
}


// =====================================
// PASSWORD VISIBILITY
// =====================================

function togglePassword(input, button) {
    if (!input || !button) return;

    const visible = input.type === "password";

    input.type = visible ? "text" : "password";
    button.textContent = visible ? "Hide" : "Show";
}


// =====================================
// SESSION STORAGE
// =====================================

function saveSession(token, savedUsername, expiresAt) {
    if (!token) return;

    try {
        const session = {
            token: token,
            username: savedUsername || username,
            expires_at: expiresAt || null
        };

        localStorage.setItem(
            SESSION_STORAGE_KEY,
            JSON.stringify(session)
        );

        sessionToken = token;
        sessionExpiresAt = expiresAt || null;
        username = session.username;

        // Eski parol saqlangan yozuvni o'chirish
        localStorage.removeItem(STORAGE_KEY);

        legacyCredentials = null;
        autoLoginEnabled = true;

    } catch (error) {
        console.error("Session storage error:", error);
    }
}

function loadSession() {
    try {
        const saved = localStorage.getItem(SESSION_STORAGE_KEY);

        if (!saved) return null;

        const session = JSON.parse(saved);

        if (
            !session ||
            typeof session.token !== "string" ||
            !session.token ||
            typeof session.username !== "string" ||
            !session.username
        ) {
            return null;
        }

        return session;

    } catch (error) {
        console.error("Session loading error:", error);
        return null;
    }
}

function loadLegacyAccount() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);

        if (!saved) return null;

        const account = JSON.parse(saved);

        if (
            !account ||
            typeof account.username !== "string" ||
            typeof account.password !== "string"
        ) {
            return null;
        }

        return account;

    } catch (error) {
        console.error("Legacy account loading error:", error);
        return null;
    }
}

function removeSavedSession() {
    localStorage.removeItem(SESSION_STORAGE_KEY);
    localStorage.removeItem(STORAGE_KEY);

    sessionToken = null;
    sessionExpiresAt = null;
    legacyCredentials = null;

    autoLoginEnabled = false;
}


// =====================================
// CONNECT TO SERVER
// =====================================

function connectAndAuthenticate(type, data) {
    return new Promise((resolve, reject) => {

        if (connectionInProgress) {
            reject(new Error("Connection is already in progress."));
            return;
        }

        connectionInProgress = true;

        if (socket) {
            try {
                socket.close();
            } catch (error) {
                console.warn(error);
            }

            socket = null;
        }

        let settled = false;

        const ws = new WebSocket(SERVER_URL);
        socket = ws;

        const timeout = setTimeout(() => {
            fail(new Error("Connection timed out. Please try again."));
            ws.close();
        }, 30000);

        function finish() {
            clearTimeout(timeout);
            connectionInProgress = false;
        }

        function fail(error) {
            if (settled) return;

            settled = true;
            finish();
            reject(error);
        }

        function succeed() {
            if (settled) return;

            settled = true;
            finish();
            resolve(true);
        }

        ws.onopen = () => {
            setStatus(false, "Authenticating...");

            const packet = {
                type: type,
                ...data
            };

            ws.send(JSON.stringify(packet));
        };

        ws.onmessage = (event) => {
            let packet;

            try {
                packet = JSON.parse(event.data);
            } catch (error) {
                console.error("Invalid server packet:", error);
                return;
            }

            handlePacket(packet, succeed, fail);
        };

        ws.onerror = () => {
            setStatus(false, "Connection error");

            fail(new Error("Unable to connect to PyChat server."));
        };

        ws.onclose = () => {
            finish();

            if (socket === ws) {
                socket = null;
            }

            joined = false;
            updateSendAvailability();

            if (!settled) {
                fail(new Error("Connection closed. Please try again."));
            }

            setStatus(false, "Disconnected");

            if (autoLoginEnabled && !manualDisconnect) {
                setStatus(false, "Reconnecting...");
                scheduleReconnect();
            } else if (!autoLoginEnabled && !manualDisconnect) {
                if (loginError) {
                    loginError.textContent =
                        "Connection closed. Please try again.";
                }
            }
        };
    });
}


// =====================================
// AUTHENTICATION HELPER
// =====================================

function authenticateWithSession() {
    if (!sessionToken) {
        return Promise.reject(
            new Error("No saved session token.")
        );
    }

    return connectAndAuthenticate("RESUME", {
        token: sessionToken
    });
}

function authenticateWithLegacyAccount() {
    if (!legacyCredentials) {
        return Promise.reject(
            new Error("No saved account.")
        );
    }

    return connectAndAuthenticate("LOGIN", {
        username: legacyCredentials.username,
        password: legacyCredentials.password
    });
}


// =====================================
// AUTOMATIC RECONNECT
// =====================================

function scheduleReconnect() {
    if (!autoLoginEnabled || manualDisconnect) return;
    if (reconnectTimer) return;

    const delay = Math.min(
        2000 * Math.pow(2, reconnectAttempts),
        30000
    );

    reconnectAttempts++;

    setStatus(false, "Reconnecting...");

    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;

        if (manualDisconnect || !autoLoginEnabled) return;

        try {
            if (sessionToken) {
                await authenticateWithSession();

            } else if (legacyCredentials) {
                await authenticateWithLegacyAccount();

            } else {
                autoLoginEnabled = false;
                showLogin();
                return;
            }

            reconnectAttempts = 0;

        } catch (error) {
            console.log("Reconnect failed:", error.message);

            if (autoLoginEnabled && !manualDisconnect) {
                scheduleReconnect();
            }
        }

    }, delay);
}


// =====================================
// HANDLE SERVER PACKETS
// =====================================

function handlePacket(packet, onSuccess, onError) {
    if (!packet || !packet.type) return;

    switch (packet.type) {

        case "WELCOME": {
            joined = true;
            reconnectAttempts = 0;

            username = packet.username || username;

            // Serverdan kelgan tokenni saqlash
            if (packet.token) {
                saveSession(
                    packet.token,
                    username,
                    packet.expires_at
                );
            }

            autoLoginEnabled = Boolean(sessionToken || autoLoginEnabled);

            setStatus(true, "Connected");
            updateSendAvailability();

            if (myUsername) {
                myUsername.textContent = username;
            }

            if (myAvatar) {
                myAvatar.textContent =
                    username.charAt(0).toUpperCase() || "U";
            }

            if (messages) {
                messages.replaceChildren();
            }

            if (loginScreen) loginScreen.classList.add("hidden");
            if (chatScreen) chatScreen.classList.remove("hidden");

            if (chatTitle) {
                chatTitle.textContent = "General Chat";
            }

            if (chatSubtitle) {
                chatSubtitle.textContent =
                    "Welcome to the PyChat community";
            }

            addNotice(packet.message || "Welcome to PyChat!");

            if (typeof onSuccess === "function") {
                onSuccess();
            }

            break;
        }

        case "HISTORY": {
            const history = Array.isArray(packet.messages)
                ? packet.messages
                : [];

            history.forEach((item) => {
                if (!item) return;

                addMessage(
                    item.username || "User",
                    item.message || ""
                );
            });

            break;
        }

        case "MESSAGE": {
            addMessage(
                packet.username || "User",
                packet.message || ""
            );

            break;
        }

        case "NOTICE": {
            addNotice(packet.message || "");
            break;
        }

        case "USERS": {
            const users = Array.isArray(packet.users)
                ? packet.users
                : [];

            updateUsers(users);

            if (userCount) {
                userCount.textContent = String(
                    packet.count ?? users.length
                );
            }

            break;
        }

        case "ERROR": {
            const error = new Error(
                packet.message || "Authentication failed."
            );

            if (!joined && typeof onError === "function") {
                onError(error);
            } else {
                addNotice("Error: " + error.message);
            }

            break;
        }

        case "PONG":
            break;
    }
}


// =====================================
// LOGIN
// =====================================

async function login() {
    const name = loginUsername?.value.trim() || "";
    const password = loginPassword?.value || "";

    if (loginError) loginError.textContent = "";

    if (!name || !password) {
        if (loginError) {
            loginError.textContent =
                "Please enter your username and password.";
        }

        return;
    }

    if (loginButton) {
        loginButton.disabled = true;
        loginButton.textContent = "Signing in...";
    }

    manualDisconnect = false;

    const credentials = {
        username: name,
        password: password
    };

    try {
        await connectAndAuthenticate("LOGIN", credentials);

        if (loginPassword) loginPassword.value = "";

    } catch (error) {
        if (loginError) {
            loginError.textContent = error.message;
        }
    } finally {
        if (loginButton) {
            loginButton.disabled = false;
            loginButton.textContent = "Sign In";
        }
    }
}


// =====================================
// REGISTER
// =====================================

async function register() {
    const name = registerUsername?.value.trim() || "";
    const password = registerPassword?.value || "";
    const confirmation = confirmPassword?.value || "";

    if (registerError) registerError.textContent = "";

    if (!name || !password || !confirmation) {
        if (registerError) {
            registerError.textContent = "Please complete all fields.";
        }

        return;
    }

    if (!/^[a-zA-Z0-9_]{3,30}$/.test(name)) {
        if (registerError) {
            registerError.textContent =
                "Use 3-30 letters, numbers or underscores.";
        }

        return;
    }

    if (password.length < 8 || password.length > 128) {
        if (registerError) {
            registerError.textContent =
                "Password must contain 8-128 characters.";
        }

        return;
    }

    if (password !== confirmation) {
        if (registerError) {
            registerError.textContent = "Passwords do not match.";
        }

        return;
    }

    if (registerButton) {
        registerButton.disabled = true;
        registerButton.textContent = "Creating account...";
    }

    manualDisconnect = false;

    const credentials = {
        username: name,
        password: password
    };

    try {
        await connectAndAuthenticate("REGISTER", credentials);

        if (registerPassword) registerPassword.value = "";
        if (confirmPassword) confirmPassword.value = "";

    } catch (error) {
        if (registerError) {
            registerError.textContent = error.message;
        }
    } finally {
        if (registerButton) {
            registerButton.disabled = false;
            registerButton.textContent = "Create Account";
        }
    }
}


// =====================================
// AUTOMATIC SESSION RESTORE
// =====================================

async function automaticLogin() {
    const savedSession = loadSession();

    const savedAccount = savedSession
        ? null
        : loadLegacyAccount();

    if (!savedSession && !savedAccount) {
        showLoginForm();
        return;
    }

    manualDisconnect = false;
    autoLoginEnabled = true;

    if (savedSession) {
        sessionToken = savedSession.token;
        sessionExpiresAt = savedSession.expires_at;
        username = savedSession.username;

        // Chat oynasini darhol ko'rsatish
        showChatImmediately(username);

    } else {
        legacyCredentials = savedAccount;
        username = savedAccount.username;

        showChatImmediately(username);
    }

    try {
        if (savedSession) {
            await authenticateWithSession();

        } else {
            // Eski versiyadagi parol orqali bir martalik login.
            // Server token qaytarsa, WELCOME uni yangi kalitga saqlaydi.
            await authenticateWithLegacyAccount();
        }

        reconnectAttempts = 0;

    } catch (error) {
        console.log("Automatic authentication failed:", error.message);

        clearTimeout(reconnectTimer);
        reconnectTimer = null;

        // Token yaroqsiz yoki muddati tugagan bo'lsa,
        // login oynasiga qaytamiz.
        if (savedSession) {
            removeSavedSession();
            showLogin();
            showLoginForm();

            if (loginError) {
                loginError.textContent =
                    "Your session has expired. Please sign in again.";
            }

        } else {
            const message = error.message.toLowerCase();

            if (
                message.includes("incorrect username") ||
                message.includes("already online") ||
                message.includes("invalid") ||
                message.includes("password")
            ) {
                removeSavedSession();
                showLogin();
                showLoginForm();

                if (loginError) {
                    loginError.textContent = error.message;
                }

            } else {
                setStatus(false, "Reconnecting...");
                scheduleReconnect();
            }
        }
    }
}


// =====================================
// SEND MESSAGE
// =====================================

function sendMessage() {
    if (!messageInput || !joined) return;

    const text = messageInput.value.trim();

    if (!text) return;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
        addNotice("Connection is not available.");
        return;
    }

    socket.send(JSON.stringify({
        type: "MESSAGE",
        message: text
    }));

    messageInput.value = "";
    messageInput.focus();
}


// =====================================
// DISPLAY MESSAGE
// =====================================

function addMessage(sender, text) {
    if (!messages) return;

    const emptyState = messages.querySelector(".empty-state");

    if (emptyState) emptyState.remove();

    const message = document.createElement("div");

    message.className =
        "message" + (sender === username ? " mine" : "");

    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = sender;

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.textContent = text;

    message.append(meta, bubble);

    messages.appendChild(message);
    messages.scrollTop = messages.scrollHeight;
}


// =====================================
// SYSTEM NOTICE
// =====================================

function addNotice(text) {
    if (!messages) return;

    const notice = document.createElement("div");

    notice.className = "notice";
    notice.textContent = text;

    messages.appendChild(notice);
    messages.scrollTop = messages.scrollHeight;
}


// =====================================
// ONLINE USERS
// =====================================

function updateUsers(users) {
    if (!userList) return;

    userList.replaceChildren();

    users.forEach((user) => {
        const name = typeof user === "string"
            ? user
            : user?.username;

        if (!name) return;

        const li = document.createElement("li");

        const avatar = document.createElement("div");
        avatar.className = "user-avatar";
        avatar.textContent = name.charAt(0).toUpperCase();

        const label = document.createElement("span");
        label.textContent = name;

        const indicator = document.createElement("span");
        indicator.className = "online-indicator";

        li.append(avatar, label, indicator);

        userList.appendChild(li);
    });
}


// =====================================
// AVATAR PREVIEW
// =====================================

avatarUpload?.addEventListener("change", () => {
    const file = avatarUpload.files?.[0];

    if (!file) return;

    if (!file.type.startsWith("image/")) {
        alert("Please select an image.");
        avatarUpload.value = "";
        return;
    }

    if (file.size > 5 * 1024 * 1024) {
        alert("Image must be smaller than 5 MB.");
        avatarUpload.value = "";
        return;
    }

    const reader = new FileReader();

    reader.onload = () => {
        if (myAvatarImage) {
            myAvatarImage.src = reader.result;
            myAvatarImage.classList.remove("hidden");
        }

        if (myAvatar) {
            myAvatar.classList.add("hidden");
        }
    };

    reader.readAsDataURL(file);
});


// =====================================
// PROFILE MENU
// =====================================

profileMenuButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    profileMenu?.classList.toggle("hidden");
});

changeAvatarButton?.addEventListener("click", () => {
    profileMenu?.classList.add("hidden");
    avatarUpload?.click();
});

document.addEventListener("click", (event) => {
    if (!profileMenu || profileMenu.classList.contains("hidden")) {
        return;
    }

    if (
        !profileMenu.contains(event.target) &&
        !profileMenuButton?.contains(event.target)
    ) {
        profileMenu.classList.add("hidden");
    }
});


// =====================================
// LEAVE CHAT
// =====================================

function leaveChat() {
    manualDisconnect = true;
    autoLoginEnabled = false;
    joined = false;

    clearTimeout(reconnectTimer);
    reconnectTimer = null;

    updateSendAvailability();

    if (socket) {
        const oldSocket = socket;
        socket = null;

        if (oldSocket.readyState === WebSocket.OPEN) {
            oldSocket.send(JSON.stringify({
                type: "LEAVE"
            }));
        }

        oldSocket.close();
    }

    showLogin();
}


// =====================================
// LOGOUT
// =====================================

function logout() {
    manualDisconnect = true;
    joined = false;

    clearTimeout(reconnectTimer);
    reconnectTimer = null;

    // Serverdagi 30 kunlik sessiyani bekor qilish
    if (socket && socket.readyState === WebSocket.OPEN) {
        try {
            socket.send(JSON.stringify({
                type: "LOGOUT",
                token: sessionToken
            }));
        } catch (error) {
            console.warn("Logout request error:", error);
        }
    }

    const oldSocket = socket;
    socket = null;

    if (oldSocket) {
        oldSocket.close();
    }

    removeSavedSession();

    updateSendAvailability();

    if (loginPassword) loginPassword.value = "";
    if (loginUsername) loginUsername.value = "";

    if (myAvatarImage) {
        myAvatarImage.classList.add("hidden");
    }

    if (myAvatar) {
        myAvatar.classList.remove("hidden");
    }

    profileMenu?.classList.add("hidden");

    showLogin();
    showLoginForm();
}


// =====================================
// EVENT LISTENERS
// =====================================

loginForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    login();
});

registerForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    register();
});

showRegister?.addEventListener("click", (event) => {
    event.preventDefault();
    showRegisterForm();
});

showLoginButton?.addEventListener("click", (event) => {
    event.preventDefault();
    showLoginForm();
});

toggleLoginPassword?.addEventListener("click", () => {
    togglePassword(loginPassword, toggleLoginPassword);
});

toggleRegisterPassword?.addEventListener("click", () => {
    togglePassword(registerPassword, toggleRegisterPassword);
});

sendButton?.addEventListener("click", sendMessage);

messageInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
        event.preventDefault();
        sendMessage();
    }
});

leaveButton?.addEventListener("click", leaveChat);
logoutButton?.addEventListener("click", logout);


// =====================================
// NETWORK / PAGE VISIBILITY
// =====================================

window.addEventListener("online", () => {
    if (autoLoginEnabled && !joined) {
        scheduleReconnect();
    }
});

document.addEventListener("visibilitychange", () => {
    if (
        document.visibilityState === "visible" &&
        autoLoginEnabled &&
        !joined &&
        (!socket || socket.readyState === WebSocket.CLOSED)
    ) {
        scheduleReconnect();
    }
});


// =====================================
// INITIALIZE
// =====================================

setStatus(false, "Offline");
showLoginForm();
updateSendAvailability();

automaticLogin();
