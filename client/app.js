
"use strict";

// ==========================================
// PYCHAT — SERVER COMPATIBLE CLIENT
// LOGIN / REGISTER / 30-DAY SESSION / RECONNECT
// ==========================================

const WS_URL = "wss://pychat-8gdk.onrender.com";
const SESSION_STORAGE_KEY = "pychat_session_token";

const $ = (id) => document.getElementById(id);

// DOM
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

// STATE
let socket = null;
let reconnectTimer = null;
let pingTimer = null;

let currentUser = null;
let joined = false;
let connecting = false;
let manuallyLoggedOut = false;
let resumingSession = false;

let onlineUsers = [];
let activeChat = "general";

let conversations = {
    general: []
};

// HELPERS
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
        statusDot.classList.remove("online");

        if (state === "online") {
            statusDot.classList.add("online");
        }
    }
}

function updateSendAvailability() {
    const canSend =
        Boolean(socket) &&
        socket.readyState === WebSocket.OPEN &&
        Boolean(currentUser) &&
        joined;

    if (messageInput) messageInput.disabled = !canSend;
    if (sendButton) sendButton.disabled = !canSend;
    if (attachButton) attachButton.disabled = !canSend;
}

function resetAuthButtons() {
    if (loginButton) loginButton.disabled = false;
    if (registerButton) registerButton.disabled = false;
}

function showAuthScreen() {
    if (loginScreen) loginScreen.classList.remove("hidden");
    if (chatScreen) chatScreen.classList.add("hidden");

    joined = false;
    currentUser = null;

    resetAuthButtons();
    updateSendAvailability();
}

function showChatScreen(username) {
    currentUser = username;

    if (loginScreen) loginScreen.classList.add("hidden");
    if (chatScreen) chatScreen.classList.remove("hidden");

    resetAuthButtons();

    if (myAvatarEl) {
        myAvatarEl.textContent =
            (username[0] || "U").toUpperCase();
    }

    if (myUsernameEl) {
        myUsernameEl.textContent = username;
    }

    if (myAvatarImageEl) {
        myAvatarImageEl.classList.add("hidden");
    }

    switchChat("general");
}

function ensureConversation(key) {
    if (!conversations[key]) {
        conversations[key] = [];
    }

    return conversations[key];
}

// Supports both "text" and "content" message fields.
function normalizeMessage(raw) {
    return {
        id: raw.id ?? null,
        sender: raw.sender ?? raw.username ?? "Unknown",
        to: raw.to ?? raw.recipient ?? null,
        text: raw.text ?? raw.content ?? "",
        time: raw.time ?? raw.created_at ?? raw.createdAt ?? null
    };
}

function getConversationKeyForMessage(raw) {
    const msg = normalizeMessage(raw);

    const sender = normalizeUser(msg.sender);
    const recipient = normalizeUser(msg.to);
    const me = normalizeUser(currentUser);

    if (!recipient) {
        return "general";
    }

    return sender === me ? recipient : sender;
}

// CONNECTION
function sendJson(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        return false;
    }

    try {
        socket.send(JSON.stringify(payload));
        return true;
    } catch (error) {
        console.error("PyChat send error:", error);
        return false;
    }
}

function connectSocket() {
    if (connecting) return;

    if (
        socket &&
        (
            socket.readyState === WebSocket.OPEN ||
            socket.readyState === WebSocket.CONNECTING
        )
    ) {
        return;
    }

    connecting = true;
    setConnectionStatus("connecting", "Connecting...");

    try {
        socket = new WebSocket(WS_URL);
    } catch (error) {
        connecting = false;
        setConnectionStatus("offline", "Disconnected");
        scheduleReconnect();
        return;
    }

    socket.addEventListener("open", () => {
        connecting = false;

        setConnectionStatus("online", "Connected");

        const savedToken = localStorage.getItem(
            SESSION_STORAGE_KEY
        );

        if (savedToken && !manuallyLoggedOut) {
            resumingSession = true;

            // Server expects RESUME, not RESUME_SESSION.
            sendJson({
                type: "RESUME",
                token: savedToken
            });
        } else {
            resumingSession = false;
            showAuthScreen();
        }

        clearInterval(pingTimer);

        pingTimer = setInterval(() => {
            sendJson({ type: "PING" });
        }, 25000);

        updateSendAvailability();
    });

    socket.addEventListener("message", (event) => {
        let packet;

        try {
            packet = JSON.parse(event.data);
        } catch (error) {
            console.error("Invalid server response:", error);
            return;
        }

        handlePacket(packet);
    });

    socket.addEventListener("close", () => {
        connecting = false;
        joined = false;

        clearInterval(pingTimer);

        updateSendAvailability();

        if (!manuallyLoggedOut) {
            setConnectionStatus("offline", "Reconnecting...");
            scheduleReconnect();
        } else {
            setConnectionStatus("offline", "Disconnected");
        }
    });

    socket.addEventListener("error", () => {
        connecting = false;
        setConnectionStatus("offline", "Connection error");
    });
}

function scheduleReconnect() {
    if (manuallyLoggedOut) return;

    clearTimeout(reconnectTimer);

    reconnectTimer = setTimeout(() => {
        connectSocket();
    }, 2500);
}

// SERVER PACKETS
function handlePacket(packet) {
    if (!packet || !packet.type) return;

    switch (packet.type) {
        case "WELCOME": {
            joined = true;
            resumingSession = false;
            manuallyLoggedOut = false;

            if (packet.token) {
                localStorage.setItem(
                    SESSION_STORAGE_KEY,
                    packet.token
                );
            }

            if (loginErrorEl) loginErrorEl.textContent = "";
            if (registerErrorEl) registerErrorEl.textContent = "";

            conversations = { general: [] };

            const username =
                packet.username ||
                currentUser ||
                loginUsernameInput?.value?.trim();

            if (username) {
                showChatScreen(username);
            }

            updateSendAvailability();
            break;
        }

        case "HISTORY": {
            conversations = { general: [] };

            const messages = Array.isArray(packet.messages)
                ? packet.messages
                : [];

            messages.forEach((raw) => {
                const msg = normalizeMessage(raw);
                const key = getConversationKeyForMessage(msg);

                ensureConversation(key).push(msg);
            });

            renderConversationsSidebar();
            renderActiveMessages();
            break;
        }

        case "USERS": {
            renderOnlineUsers(packet.users || []);
            break;
        }

        case "MESSAGE": {
            ingestMessage(packet);
            break;
        }

        case "ERROR": {
            const message =
                packet.message || "Authentication failed.";

            if (resumingSession) {
                localStorage.removeItem(SESSION_STORAGE_KEY);
                resumingSession = false;
                showAuthScreen();

                if (loginErrorEl) {
                    loginErrorEl.textContent =
                        "Sessiya muddati tugagan. Qayta login qiling.";
                }
            } else if (!joined) {
                if (registerForm && !registerForm.classList.contains("hidden")) {
                    if (registerErrorEl) {
                        registerErrorEl.textContent = message;
                    }
                } else {
                    if (loginErrorEl) {
                        loginErrorEl.textContent = message;
                    }
                }

                resetAuthButtons();
            } else {
                alert(message);
            }

            break;
        }

        case "PONG":
            break;

        case "MESSAGE_DELETED": {
            const targetId = packet.id;

            Object.keys(conversations).forEach((key) => {
                conversations[key] =
                    conversations[key].filter(
                        (message) => message.id !== targetId
                    );
            });

            renderActiveMessages();
            break;
        }

        default:
            console.log("Unknown PyChat packet:", packet.type);
    }
}

// CHAT UI
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
                (activeChat[0] || "U").toUpperCase();
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

    const savedPeers = Object.keys(conversations)
        .filter((key) => key !== "general");

    const onlinePeers = onlineUsers
        .map(normalizeUser)
        .filter((user) => user && user !== normalizeUser(currentUser));

    const allPeers = Array.from(
        new Set([...savedPeers, ...onlinePeers])
    ).filter((peer) => !query || peer.includes(query));

    const generalLi = document.createElement("li");
    generalLi.className = "online-user-item";
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

    allPeers.forEach((peer) => {
        const li = document.createElement("li");
        li.className = "online-user-item";
        li.style.cursor = "pointer";

        const avatar = document.createElement("span");
        avatar.className = "user-avatar";
        avatar.textContent = (peer[0] || "U").toUpperCase();

        const label = document.createElement("span");
        label.className = "online-user-label";
        label.textContent = peer;

        li.append(avatar, label);

        li.addEventListener("click", () => {
            switchChat(peer);
        });

        conversationListEl.appendChild(li);
    });
}

function appendMention(username) {
    if (!messageInput || messageInput.disabled) return;

    const prefix =
        messageInput.value && !messageInput.value.endsWith(" ")
            ? " "
            : "";

    messageInput.value += `${prefix}@${username} `;
    messageInput.focus();
}

function createOnlineChip(username, compact = false) {
    const cleanName = normalizeUser(username);

    const chip = document.createElement("div");
    chip.className = "online-user-chip";
    chip.style.cursor = "pointer";
    chip.title = `${cleanName} bilan shaxsiy chat ochish`;

    const avatar = document.createElement("span");
    avatar.className = compact
        ? "online-user-avatar"
        : "user-avatar";
    avatar.textContent = (cleanName[0] || "U").toUpperCase();

    const nameEl = document.createElement("span");
    nameEl.className = "online-user-name";
    nameEl.textContent = cleanName;

    const mentionBtn = document.createElement("button");
    mentionBtn.type = "button";
    mentionBtn.textContent = "@";
    mentionBtn.title = `@${cleanName} ni xabarga qo'shish`;
    mentionBtn.style.border = "none";
    mentionBtn.style.background = "transparent";
    mentionBtn.style.fontWeight = "700";
    mentionBtn.style.cursor = "pointer";
    mentionBtn.style.padding = "0 2px";

    mentionBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        appendMention(cleanName);
    });

    const dot = document.createElement("span");
    dot.className = "online-indicator";

    chip.append(avatar, nameEl, mentionBtn, dot);

    chip.addEventListener("click", () => {
        if (
            cleanName &&
            cleanName !== normalizeUser(currentUser)
        ) {
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

    const filtered = onlineUsers.filter((user) => {
        return normalizeUser(user).includes(query);
    });

    if (userCountEl) {
        userCountEl.textContent = String(onlineUsers.length);
    }

    if (topOnlineCountEl) {
        topOnlineCountEl.textContent = String(onlineUsers.length);
    }

    if (onlineNowCountEl) {
        onlineNowCountEl.textContent =
            `${onlineUsers.length} online`;
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
                    createOnlineChip(user, false)
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
                "Hozircha online foydalanuvchilar yo‘q";
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
            const cleanName = normalizeUser(user);

            const li = document.createElement("li");
            li.className = "online-user-item";
            li.style.cursor = "pointer";

            const avatar = document.createElement("span");
            avatar.className = "user-avatar";
            avatar.textContent =
                (cleanName[0] || "U").toUpperCase();

            const label = document.createElement("span");
            label.className = "online-user-label";
            label.textContent = cleanName;

            const dot = document.createElement("span");
            dot.className = "online-indicator";

            li.append(avatar, label, dot);

            li.addEventListener("click", () => {
                if (cleanName !== normalizeUser(currentUser)) {
                    switchChat(cleanName);
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

// MESSAGES
function appendMessageElement(raw) {
    if (!messagesContainer) return;

    const msg = normalizeMessage(raw);

    const emptyState = messagesContainer.querySelector(".empty-state");

    if (emptyState) {
        emptyState.classList.add("hidden");
    }

    const isMine =
        normalizeUser(msg.sender) === normalizeUser(currentUser);

    const wrapper = document.createElement("div");
    wrapper.className = `message ${isMine ? "mine" : ""}`;

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const time = formatTime(msg.time);

    meta.textContent = time
        ? `${msg.sender} • ${time}`
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

    messagesContainer.scrollTop =
        messagesContainer.scrollHeight;
}

function renderActiveMessages() {
    if (!messagesContainer) return;

    const list = ensureConversation(activeChat);
    messagesContainer.innerHTML = "";

    if (!list.length) {
        const emptyState = document.createElement("div");
        emptyState.className = "empty-state";
        emptyState.textContent = "No messages yet.";
        messagesContainer.appendChild(emptyState);
        return;
    }

    list.forEach((msg) => {
        appendMessageElement(msg);
    });
}

function ingestMessage(raw) {
    const msg = normalizeMessage(raw);
    const key = getConversationKeyForMessage(msg);

    ensureConversation(key).push(msg);

    if (key === activeChat) {
        appendMessageElement(msg);
    }

    renderConversationsSidebar();
}

function sendCurrentMessage(customContent = null) {
    if (!joined || !currentUser || !messageInput) return;

    const content = customContent !== null
        ? customContent
        : messageInput.value.trim();

    if (!content) return;

    const payload = {
        type: "MESSAGE",
        text: content,
        to: activeChat === "general" ? null : activeChat
    };

    if (sendJson(payload) && customContent === null) {
        messageInput.value = "";
        messageInput.focus();
    }
}

// AUTH
function submitAuth(type, username, password) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        if (loginErrorEl) {
            loginErrorEl.textContent =
                "Server bilan aloqa yo'q. Qayta ulanilmoqda...";
        }

        connectSocket();
        return false;
    }

    if (loginButton) loginButton.disabled = type === "LOGIN";
    if (registerButton) registerButton.disabled = type === "REGISTER";

    const sent = sendJson({
        type,
        username,
        password
    });

    if (!sent) {
        resetAuthButtons();
        return false;
    }

    return true;
}

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

    manuallyLoggedOut = false;

    submitAuth("LOGIN", username, password);
});

registerForm?.addEventListener("submit", (event) => {
    event.preventDefault();

    if (registerErrorEl) registerErrorEl.textContent = "";

    const username = (registerUsernameInput?.value || "").trim();
    const password = registerPasswordInput?.value || "";
    const confirmPassword = confirmPasswordInput?.value || "";

    if (!username || password.length < 8) {
        if (registerErrorEl) {
            registerErrorEl.textContent =
                "Username kiriting va parol kamida 8 belgi bo'lsin.";
        }
        return;
    }

    if (password !== confirmPassword) {
        if (registerErrorEl) {
            registerErrorEl.textContent =
                "Parollar bir xil emas.";
        }
        return;
    }

    manuallyLoggedOut = false;

    submitAuth("REGISTER", username, password);
});

// AUTH SCREEN BUTTONS
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

// PROFILE MENU
profileMenuButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    profileMenuEl?.classList.toggle("hidden");
});

document.addEventListener("click", () => {
    profileMenuEl?.classList.add("hidden");
});

// LOGOUT
logoutButton?.addEventListener("click", () => {
    manuallyLoggedOut = true;

    sendJson({ type: "LOGOUT" });

    localStorage.removeItem(SESSION_STORAGE_KEY);

    clearTimeout(reconnectTimer);
    clearInterval(pingTimer);

    joined = false;
    currentUser = null;

    if (socket) {
        socket.close();
    }

    showAuthScreen();
    setConnectionStatus("offline", "Disconnected");
});

// CHAT EVENTS
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

// IMAGE UPLOAD
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

    if (file.size > 900 * 1024) {
        alert("Rasm hajmi 900 KB dan kichik bo'lishi kerak.");
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

    reader.onerror = () => {
        alert("Rasmni o'qishda xatolik yuz berdi.");
        fileUploadInput.value = "";
    };

    reader.readAsDataURL(file);
});

// START
connectSocket();
