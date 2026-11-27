
"use strict";

// ============================================
// PYCHAT CLIENT — MATCHES PYCHAT SERVER PROTOCOL
// LOGIN / REGISTER / RESUME / WELCOME / USERS
// ============================================

const WS_URL = "wss://pychat-8gdk.onrender.com";
const SESSION_STORAGE_KEY = "pychat_session_token";

const $ = (id) => document.getElementById(id);

const statusDot = $("statusDot");
const connectionStatusEl = $("connectionStatus");

const loginScreen = $("loginScreen");
const chatScreen = $("chatScreen");

const loginForm = $("loginForm");
const loginUsernameInput = $("loginUsername");
const loginPasswordInput = $("loginPassword");
const toggleLoginPasswordBtn = $("toggleLoginPassword");
const loginButton = $("loginButton");
const loginErrorEl = $("loginError");
const showRegisterBtn = $("showRegister");

const registerForm = $("registerForm");
const registerUsernameInput = $("registerUsername");
const registerPasswordInput = $("registerPassword");
const confirmPasswordInput = $("confirmPassword");
const toggleRegisterPasswordBtn = $("toggleRegisterPassword");
const registerButton = $("registerButton");
const registerErrorEl = $("registerError");
const showLoginBtn = $("showLogin");

const myAvatarEl = $("myAvatar");
const myAvatarImageEl = $("myAvatarImage");
const myUsernameEl = $("myUsername");
const profileMenuButton = $("profileMenuButton");
const profileMenuEl = $("profileMenu");
const logoutButton = $("logoutButton");

const userSearchInput = $("userSearch");
const conversationListEl = $("conversationList");
const userListEl = $("userList");
const userCountEl = $("userCount");

const topOnlineUsersEl = $("topOnlineUsers");
const topOnlineCountEl = $("topOnlineCount");
const onlineNowUsersEl = $("onlineNowUsers");
const onlineNowCountEl = $("onlineNowCount");

const chatAvatarEl = $("chatAvatar");
const chatTitleEl = $("chatTitle");
const chatSubtitleEl = $("chatSubtitle");
const leaveButton = $("leaveButton");

const messagesContainer = $("messages");
const messageInput = $("messageInput");
const sendButton = $("sendButton");
const attachButton = $("attachButton");
const fileUploadInput = $("fileUpload");

let socket = null;
let reconnectTimer = null;
let pingTimer = null;

let currentUser = null;
let joined = false;
let manuallyLoggedOut = false;
let authMode = null;
let pendingAuth = null;

let onlineUsers = [];
let activeChat = "general";
let conversations = { general: [] };

function normalizeUser(name) {
    return String(name || "").trim().toLowerCase();
}

function formatTime(value) {
    if (!value) return "";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";

    return date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
    });
}

function setConnectionStatus(state, label) {
    if (connectionStatusEl) {
        connectionStatusEl.textContent = label;
    }

    if (statusDot) {
        statusDot.classList.toggle("online", state === "online");
    }
}

function resetAuthButtons() {
    if (loginButton) loginButton.disabled = false;
    if (registerButton) registerButton.disabled = false;
}

function updateSendAvailability() {
    const canSend =
        socket &&
        socket.readyState === WebSocket.OPEN &&
        currentUser &&
        joined;

    if (messageInput) messageInput.disabled = !canSend;
    if (sendButton) sendButton.disabled = !canSend;
    if (attachButton) attachButton.disabled = !canSend;
}

function showAuthScreen() {
    if (loginScreen) loginScreen.classList.remove("hidden");
    if (chatScreen) chatScreen.classList.add("hidden");

    joined = false;
    updateSendAvailability();
    resetAuthButtons();
}

function showChatScreen(username) {
    if (!username) return;

    currentUser = username;

    if (loginScreen) loginScreen.classList.add("hidden");
    if (chatScreen) chatScreen.classList.remove("hidden");

    if (myAvatarEl) {
        myAvatarEl.textContent = username[0].toUpperCase();
    }

    if (myUsernameEl) {
        myUsernameEl.textContent = username;
    }

    if (myAvatarImageEl) {
        myAvatarImageEl.classList.add("hidden");
    }

    if (loginErrorEl) loginErrorEl.textContent = "";
    if (registerErrorEl) registerErrorEl.textContent = "";

    resetAuthButtons();
    switchChat("general");
    updateSendAvailability();
}

function ensureConversation(key) {
    if (!conversations[key]) {
        conversations[key] = [];
    }

    return conversations[key];
}

function normalizeMessage(message) {
    return {
        ...message,
        sender: message.sender || message.username || "",
        to: message.to ?? message.recipient ?? null,
        text: message.text ?? message.content ?? "",
        time: message.time || message.created_at || message.timestamp || null
    };
}

function getConversationKeyForMessage(rawMessage) {
    const msg = normalizeMessage(rawMessage);

    const sender = normalizeUser(msg.sender);
    const recipient = normalizeUser(msg.to);
    const me = normalizeUser(currentUser);

    if (!recipient) return "general";

    return sender === me ? recipient : sender;
}

function switchChat(targetKey) {
    activeChat = normalizeUser(targetKey) || "general";
    ensureConversation(activeChat);

    if (activeChat === "general") {
        if (chatAvatarEl) chatAvatarEl.textContent = "P";
        if (chatTitleEl) chatTitleEl.textContent = "General Chat";
        if (chatSubtitleEl) {
            chatSubtitleEl.textContent =
                "Welcome to the PyChat community";
        }
        if (leaveButton) leaveButton.classList.add("hidden");
    } else {
        if (chatAvatarEl) {
            chatAvatarEl.textContent =
                activeChat[0].toUpperCase();
        }

        if (chatTitleEl) {
            chatTitleEl.textContent = activeChat;
        }

        const isOnline = onlineUsers.some(
            (user) => normalizeUser(user) === activeChat
        );

        if (chatSubtitleEl) {
            chatSubtitleEl.textContent = isOnline
                ? "Private chat • Online"
                : "Private chat • Offline";
        }

        if (leaveButton) {
            leaveButton.classList.remove("hidden");
        }
    }

    renderConversationsSidebar();
    renderActiveMessages();
}

function renderConversationsSidebar() {
    if (!conversationListEl) return;

    const query = (userSearchInput?.value || "")
        .trim()
        .toLowerCase();

    conversationListEl.innerHTML = "";

    const previousChats = Object.keys(conversations)
        .filter((key) => key !== "general");

    const onlineOthers = onlineUsers
        .map(normalizeUser)
        .filter((user) =>
            user && user !== normalizeUser(currentUser)
        );

    const peers = Array.from(
        new Set([...previousChats, ...onlineOthers])
    ).filter((peer) => !query || peer.includes(query));

    const generalLi = document.createElement("li");
    generalLi.className =
        "online-user-item" +
        (activeChat === "general" ? " active" : "");
    generalLi.style.cursor = "pointer";

    const generalAvatar = document.createElement("span");
    generalAvatar.className = "user-avatar";
    generalAvatar.textContent = "P";

    const generalLabel = document.createElement("span");
    generalLabel.className = "online-user-label";
    generalLabel.textContent = "General Chat";

    generalLi.append(generalAvatar, generalLabel);
    generalLi.addEventListener("click", () => {
        switchChat("general");
    });

    conversationListEl.appendChild(generalLi);

    peers.forEach((peer) => {
        const li = document.createElement("li");
        li.className =
            "online-user-item" +
            (activeChat === peer ? " active" : "");
        li.style.cursor = "pointer";

        const avatar = document.createElement("span");
        avatar.className = "user-avatar";
        avatar.textContent = peer[0].toUpperCase();

        const label = document.createElement("span");
        label.className = "online-user-label";
        label.textContent = peer;

        li.append(avatar, label);
        li.addEventListener("click", () => switchChat(peer));

        conversationListEl.appendChild(li);
    });
}

function appendMention(username) {
    if (!messageInput || messageInput.disabled) return;

    const prefix =
        messageInput.value && !messageInput.value.endsWith(" ")
            ? " "
            : "";

    messageInput.value += prefix + "@" + username + " ";
    messageInput.focus();
}

function createOnlineChip(username, compact = false) {
    const cleanName = normalizeUser(username);

    const chip = document.createElement("div");
    chip.className = "online-user-chip";
    chip.style.cursor = "pointer";
    chip.title = "Shaxsiy chat ochish";

    const avatar = document.createElement("span");
    avatar.className = compact
        ? "online-user-avatar"
        : "user-avatar";
    avatar.textContent = cleanName[0]?.toUpperCase() || "U";

    const name = document.createElement("span");
    name.className = "online-user-name";
    name.textContent = cleanName;

    const mention = document.createElement("button");
    mention.type = "button";
    mention.textContent = "@";
    mention.style.border = "none";
    mention.style.background = "transparent";
    mention.style.cursor = "pointer";

    mention.addEventListener("click", (event) => {
        event.stopPropagation();
        appendMention(cleanName);
    });

    const dot = document.createElement("span");
    dot.className = "online-indicator";

    chip.append(avatar, name, mention, dot);

    chip.addEventListener("click", () => {
        if (cleanName !== normalizeUser(currentUser)) {
            switchChat(cleanName);
        }
    });

    return chip;
}

function renderOnlineUsers(users) {
    onlineUsers = Array.isArray(users) ? users : [];

    const query = (userSearchInput?.value || "")
        .trim()
        .toLowerCase();

    const filtered = onlineUsers.filter((user) =>
        normalizeUser(user).includes(query)
    );

    if (userCountEl) {
        userCountEl.textContent = String(onlineUsers.length);
    }

    if (topOnlineCountEl) {
        topOnlineCountEl.textContent = String(onlineUsers.length);
    }

    if (onlineNowCountEl) {
        onlineNowCountEl.textContent =
            onlineUsers.length + " online";
    }

    if (topOnlineUsersEl) {
        topOnlineUsersEl.innerHTML = "";

        if (!filtered.length) {
            const empty = document.createElement("span");
            empty.className = "top-online-empty";
            empty.textContent = "No one online right now";
            topOnlineUsersEl.appendChild(empty);
        } else {
            filtered.forEach((user) => {
                topOnlineUsersEl.appendChild(
                    createOnlineChip(user)
                );
            });
        }
    }

    if (onlineNowUsersEl) {
        onlineNowUsersEl.innerHTML = "";

        if (!filtered.length) {
            const empty = document.createElement("span");
            empty.className = "top-online-empty";
            empty.textContent =
                "Hozircha online foydalanuvchilar yo'q";
            onlineNowUsersEl.appendChild(empty);
        } else {
            filtered.forEach((user) => {
                onlineNowUsersEl.appendChild(
                    createOnlineChip(user, true)
                );
            });
        }
    }

    if (userListEl) {
        userListEl.innerHTML = "";

        filtered.forEach((user) => {
            const name = normalizeUser(user);

            const li = document.createElement("li");
            li.className = "online-user-item";
            li.style.cursor = "pointer";

            const avatar = document.createElement("span");
            avatar.className = "user-avatar";
            avatar.textContent = name[0]?.toUpperCase() || "U";

            const label = document.createElement("span");
            label.className = "online-user-label";
            label.textContent = name;

            const dot = document.createElement("span");
            dot.className = "online-indicator";

            li.append(avatar, label, dot);

            li.addEventListener("click", () => {
                if (name !== normalizeUser(currentUser)) {
                    switchChat(name);
                }
            });

            userListEl.appendChild(li);
        });
    }

    if (activeChat !== "general" && chatSubtitleEl) {
        const isOnline = onlineUsers.some(
            (user) => normalizeUser(user) === activeChat
        );

        chatSubtitleEl.textContent = isOnline
            ? "Private chat • Online"
            : "Private chat • Offline";
    }

    renderConversationsSidebar();
}

function appendMessageElement(rawMessage) {
    if (!messagesContainer) return;

    const msg = normalizeMessage(rawMessage);
    const emptyState = messagesContainer.querySelector(".empty-state");

    if (emptyState) emptyState.classList.add("hidden");

    const isMine =
        normalizeUser(msg.sender) === normalizeUser(currentUser);

    const wrapper = document.createElement("div");
    wrapper.className = "message" + (isMine ? " mine" : "");

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const time = formatTime(msg.time);
    meta.textContent = time
        ? msg.sender + " • " + time
        : msg.sender;

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";

    if (
        typeof msg.text === "string" &&
        msg.text.startsWith("data:image/")
    ) {
        const img = document.createElement("img");
        img.src = msg.text;
        img.alt = "Sent image";
        img.style.maxWidth = "240px";
        img.style.maxHeight = "240px";
        img.style.borderRadius = "10px";
        img.style.display = "block";
        bubble.appendChild(img);
    } else {
        bubble.textContent = msg.text;
    }

    wrapper.append(meta, bubble);
    messagesContainer.appendChild(wrapper);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function renderActiveMessages() {
    if (!messagesContainer) return;

    const list = ensureConversation(activeChat);
    messagesContainer.innerHTML = "";

    if (!list.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = "Hozircha xabarlar yo'q";
        messagesContainer.appendChild(empty);
        return;
    }

    list.forEach(appendMessageElement);
}

function ingestMessage(rawMessage) {
    const msg = normalizeMessage(rawMessage);
    const key = getConversationKeyForMessage(msg);

    ensureConversation(key).push(msg);

    if (key === activeChat) {
        appendMessageElement(msg);
    }

    renderConversationsSidebar();
}

function sendJson(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        return false;
    }

    try {
        socket.send(JSON.stringify(payload));
        return true;
    } catch {
        return false;
    }
}

function sendCurrentMessage(customContent = null) {
    if (!joined || !currentUser || !messageInput) return;

    const content =
        customContent !== null
            ? customContent
            : messageInput.value.trim();

    if (!content) return;

    const sent = sendJson({
        type: "MESSAGE",
        text: content,
        to: activeChat === "general" ? null : activeChat
    });

    if (sent && customContent === null) {
        messageInput.value = "";
        messageInput.focus();
    }
}

// ============================================
// AUTHENTICATION
// ============================================

function sendPendingAuthentication() {
    if (!pendingAuth || !socket ||
        socket.readyState !== WebSocket.OPEN) {
        return;
    }

    const auth = pendingAuth;
    pendingAuth = null;
    authMode = auth.type;

    if (auth.type === "RESUME") {
        sendJson({
            type: "RESUME",
            token: auth.token
        });
    } else {
        sendJson({
            type: auth.type,
            username: auth.username,
            password: auth.password
        });
    }
}

function startAuthentication(type, username, password) {
    manuallyLoggedOut = false;

    pendingAuth = {
        type,
        username,
        password
    };

    if (type === "LOGIN" && loginButton) {
        loginButton.disabled = true;
    }

    if (type === "REGISTER" && registerButton) {
        registerButton.disabled = true;
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
        sendPendingAuthentication();
    } else {
        connectSocket();
    }
}

function handleWelcome(data) {
    const username =
        data.username || data.user?.username || currentUser;

    if (!username) {
        showAuthScreen();
        return;
    }

    joined = true;
    currentUser = username;
    authMode = null;

    if (data.token) {
        localStorage.setItem(
            SESSION_STORAGE_KEY,
            data.token
        );
    }

    if (loginErrorEl) loginErrorEl.textContent = "";
    if (registerErrorEl) registerErrorEl.textContent = "";

    showChatScreen(username);
    updateSendAvailability();
}

function handleServerError(data) {
    const message = data.message || "Authentication failed.";

    if (authMode === "LOGIN" && loginErrorEl) {
        loginErrorEl.textContent = message;
    } else if (authMode === "REGISTER" && registerErrorEl) {
        registerErrorEl.textContent = message;
    } else if (authMode === "RESUME") {
        localStorage.removeItem(SESSION_STORAGE_KEY);
        currentUser = null;
        showAuthScreen();

        if (loginErrorEl) {
            loginErrorEl.textContent =
                "Sessiya tugagan. Iltimos, qayta login qiling.";
        }
    } else {
        alert(message);
    }

    authMode = null;
    pendingAuth = null;
    resetAuthButtons();
}

// ============================================
// WEBSOCKET CONNECTION
// ============================================

function connectSocket() {
    if (
        socket &&
        (socket.readyState === WebSocket.OPEN ||
         socket.readyState === WebSocket.CONNECTING)
    ) {
        return;
    }

    clearTimeout(reconnectTimer);

    setConnectionStatus("connecting", "Connecting...");

    try {
        socket = new WebSocket(WS_URL);
    } catch {
        setConnectionStatus("offline", "Disconnected");
        scheduleReconnect();
        return;
    }

    const thisSocket = socket;

    thisSocket.addEventListener("open", () => {
        if (socket !== thisSocket) return;

        setConnectionStatus("online", "Connected");

        clearInterval(pingTimer);

        pingTimer = setInterval(() => {
            if (socket === thisSocket && joined) {
                sendJson({ type: "PING" });
            }
        }, 25000);

        if (pendingAuth) {
            sendPendingAuthentication();
            return;
        }

        const savedToken =
            localStorage.getItem(SESSION_STORAGE_KEY);

        if (savedToken && !manuallyLoggedOut) {
            pendingAuth = {
                type: "RESUME",
                token: savedToken
            };

            sendPendingAuthentication();
        } else {
            showAuthScreen();
        }
    });

    thisSocket.addEventListener("message", (event) => {
        if (socket !== thisSocket) return;

        let data;

        try {
            data = JSON.parse(event.data);
        } catch {
            return;
        }

        switch (data.type) {
            // Server sends WELCOME, not AUTH_OK.
            case "WELCOME":
                handleWelcome(data);
                break;

            // Server sends USERS, not ONLINE_USERS.
            case "USERS":
            case "ONLINE_USERS":
                renderOnlineUsers(data.users || []);
                break;

            case "HISTORY": {
                conversations = { general: [] };

                (data.messages || []).forEach((rawMessage) => {
                    const msg = normalizeMessage(rawMessage);
                    const key = getConversationKeyForMessage(msg);

                    ensureConversation(key).push(msg);
                });

                renderConversationsSidebar();
                renderActiveMessages();
                break;
            }

            case "MESSAGE":
                ingestMessage(data);
                break;

            case "ERROR":
                handleServerError(data);
                break;

            case "SESSION_EXPIRED":
                localStorage.removeItem(SESSION_STORAGE_KEY);
                currentUser = null;
                joined = false;
                showAuthScreen();
                break;

            case "PONG":
                break;

            default:
                break;
        }

        updateSendAvailability();
    });

    thisSocket.addEventListener("close", () => {
        if (socket !== thisSocket) return;

        clearInterval(pingTimer);

        joined = false;
        updateSendAvailability();

        setConnectionStatus("offline", "Reconnecting...");

        if (authMode) {
            resetAuthButtons();
        }

        if (!manuallyLoggedOut) {
            scheduleReconnect();
        }
    });

    thisSocket.addEventListener("error", () => {
        if (socket !== thisSocket) return;

        setConnectionStatus("offline", "Disconnected");
    });
}

function scheduleReconnect() {
    if (manuallyLoggedOut) return;

    clearTimeout(reconnectTimer);

    reconnectTimer = setTimeout(() => {
        connectSocket();
    }, 2500);
}

// ============================================
// LOGIN / REGISTER EVENTS
// ============================================

showRegisterBtn?.addEventListener("click", () => {
    loginForm?.classList.add("hidden");
    registerForm?.classList.remove("hidden");

    if (loginErrorEl) loginErrorEl.textContent = "";
    if (registerErrorEl) registerErrorEl.textContent = "";
});

showLoginBtn?.addEventListener("click", () => {
    registerForm?.classList.add("hidden");
    loginForm?.classList.remove("hidden");

    if (loginErrorEl) loginErrorEl.textContent = "";
    if (registerErrorEl) registerErrorEl.textContent = "";
});

toggleLoginPasswordBtn?.addEventListener("click", () => {
    if (!loginPasswordInput) return;

    const show = loginPasswordInput.type === "password";
    loginPasswordInput.type = show ? "text" : "password";
    toggleLoginPasswordBtn.textContent = show ? "Hide" : "Show";
});

toggleRegisterPasswordBtn?.addEventListener("click", () => {
    if (!registerPasswordInput) return;

    const show = registerPasswordInput.type === "password";
    registerPasswordInput.type = show ? "text" : "password";
    toggleRegisterPasswordBtn.textContent = show ? "Hide" : "Show";
});

loginForm?.addEventListener("submit", (event) => {
    event.preventDefault();

    if (loginErrorEl) loginErrorEl.textContent = "";

    const username = (loginUsernameInput?.value || "").trim();
    const password = loginPasswordInput?.value || "";

    if (!username || !password) {
        if (loginErrorEl) {
            loginErrorEl.textContent =
                "Username va parolni kiriting.";
        }
        return;
    }

    startAuthentication("LOGIN", username, password);
});

registerForm?.addEventListener("submit", (event) => {
    event.preventDefault();

    if (registerErrorEl) registerErrorEl.textContent = "";

    const username = (registerUsernameInput?.value || "").trim();
    const password = registerPasswordInput?.value || "";
    const confirmation = confirmPasswordInput?.value || "";

    if (!username || password.length < 8) {
        if (registerErrorEl) {
            registerErrorEl.textContent =
                "Username kiriting va parol kamida 8 belgi bo'lsin.";
        }
        return;
    }

    if (password !== confirmation) {
        if (registerErrorEl) {
            registerErrorEl.textContent =
                "Parollar bir xil emas.";
        }
        return;
    }

    startAuthentication("REGISTER", username, password);
});

// ============================================
// PROFILE / LOGOUT
// ============================================

profileMenuButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    profileMenuEl?.classList.toggle("hidden");
});

document.addEventListener("click", () => {
    profileMenuEl?.classList.add("hidden");
});

logoutButton?.addEventListener("click", () => {
    manuallyLoggedOut = true;
    pendingAuth = null;
    authMode = null;

    sendJson({ type: "LOGOUT" });

    localStorage.removeItem(SESSION_STORAGE_KEY);

    clearTimeout(reconnectTimer);
    clearInterval(pingTimer);

    currentUser = null;
    joined = false;
    onlineUsers = [];
    conversations = { general: [] };

    if (socket) {
        const oldSocket = socket;
        socket = null;

        if (oldSocket.readyState === WebSocket.OPEN ||
            oldSocket.readyState === WebSocket.CONNECTING) {
            oldSocket.close();
        }
    }

    showAuthScreen();
    setConnectionStatus("offline", "Disconnected");
});

// ============================================
// CHAT EVENTS
// ============================================

leaveButton?.addEventListener("click", () => {
    switchChat("general");
});

userSearchInput?.addEventListener("input", () => {
    renderOnlineUsers(onlineUsers);
});

sendButton?.addEventListener("click", () => {
    sendCurrentMessage();
});

messageInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        sendCurrentMessage();
    }
});

attachButton?.addEventListener("click", () => {
    if (
        messageInput &&
        !messageInput.disabled &&
        fileUploadInput
    ) {
        fileUploadInput.click();
    }
});

fileUploadInput?.addEventListener("change", () => {
    const file = fileUploadInput.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
        alert("Faqat rasm fayllarini yuborish mumkin.");
        fileUploadInput.value = "";
        return;
    }

    // Server max_size = 64 KB.
    // Base64 rasm uchun kichikroq limit ishlatiladi.
    if (file.size > 40 * 1024) {
        alert("Hozircha rasm hajmi 40 KB dan kichik bo'lishi kerak.");
        fileUploadInput.value = "";
        return;
    }

    const reader = new FileReader();

    reader.onload = () => {
        if (typeof reader.result === "string") {
            sendCurrentMessage(reader.result);
        }

        fileUploadInput.value = "";
    };

    reader.readAsDataURL(file);
});

// ============================================
// START
// ============================================

connectSocket();
