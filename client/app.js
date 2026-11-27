
"use strict";

// =====================================
// PYCHAT — WEBSOCKET CLIENT
// Compatible with current server.py
// 30-DAY SESSION + AUTO RESUME + RECONNECT
// =====================================

const WS_URL = "wss://pychat-8gdk.onrender.com";
const SESSION_STORAGE_KEY = "pychat_session_token";

const statusDot = document.getElementById("statusDot");
const connectionStatusEl = document.getElementById("connectionStatus");
const loginScreen = document.getElementById("loginScreen");
const chatScreen = document.getElementById("chatScreen");

const loginForm = document.getElementById("loginForm");
const loginUsernameInput = document.getElementById("loginUsername");
const loginPasswordInput = document.getElementById("loginPassword");
const toggleLoginPasswordBtn = document.getElementById("toggleLoginPassword");
const loginButton = document.getElementById("loginButton");
const loginErrorEl = document.getElementById("loginError");
const showRegisterBtn = document.getElementById("showRegister");

const registerForm = document.getElementById("registerForm");
const registerUsernameInput = document.getElementById("registerUsername");
const registerPasswordInput = document.getElementById("registerPassword");
const confirmPasswordInput = document.getElementById("confirmPassword");
const toggleRegisterPasswordBtn = document.getElementById("toggleRegisterPassword");
const registerButton = document.getElementById("registerButton");
const registerErrorEl = document.getElementById("registerError");
const showLoginBtn = document.getElementById("showLogin");

const myAvatarEl = document.getElementById("myAvatar");
const myAvatarImageEl = document.getElementById("myAvatarImage");
const myUsernameEl = document.getElementById("myUsername");
const profileMenuButton = document.getElementById("profileMenuButton");
const profileMenuEl = document.getElementById("profileMenu");
const logoutButton = document.getElementById("logoutButton");

const userSearchInput = document.getElementById("userSearch");
const conversationListEl = document.getElementById("conversationList");
const userListEl = document.getElementById("userList");
const userCountEl = document.getElementById("userCount");

const topOnlineUsersEl = document.getElementById("topOnlineUsers");
const topOnlineCountEl = document.getElementById("topOnlineCount");
const onlineNowUsersEl = document.getElementById("onlineNowUsers");
const onlineNowCountEl = document.getElementById("onlineNowCount");

const chatAvatarEl = document.getElementById("chatAvatar");
const chatTitleEl = document.getElementById("chatTitle");
const chatSubtitleEl = document.getElementById("chatSubtitle");
const leaveButton = document.getElementById("leaveButton");

const messagesContainer = document.getElementById("messages");
const emptyStateEl = document.querySelector("#messages .empty-state");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");
const attachButton = document.getElementById("attachButton");
const fileUploadInput = document.getElementById("fileUpload");

let socket = null;
let reconnectTimer = null;
let pingTimer = null;

let currentUser = null;
let joined = false;
let onlineUsers = [];

let activeChat = "general";
let conversations = { general: [] };

let pendingAuth = null;
let authMode = null;
let reconnectAttempts = 0;
let manuallyLoggedOut = false;


// =====================================
// BASIC HELPERS
// =====================================

function normalizeUser(name) {
    return (name || "").trim().toLowerCase();
}

function formatTime(value) {
    if (!value) return "";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "";
    }

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

function resetAuthButtons() {
    if (loginButton) loginButton.disabled = false;
    if (registerButton) registerButton.disabled = false;
}

function updateSendAvailability() {
    const canSend =
        Boolean(
            socket &&
            socket.readyState === WebSocket.OPEN &&
            currentUser &&
            joined
        );

    if (messageInput) messageInput.disabled = !canSend;
    if (sendButton) sendButton.disabled = !canSend;
    if (attachButton) attachButton.disabled = !canSend;
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

    const initial = (username[0] || "U").toUpperCase();

    if (myAvatarEl) {
        myAvatarEl.textContent = initial;
    }

    if (myUsernameEl) {
        myUsernameEl.textContent = username;
    }

    if (myAvatarImageEl) {
        myAvatarImageEl.classList.add("hidden");
    }

    switchChat("general");
}


// =====================================
// WEBSOCKET SEND
// =====================================

function sendJson(payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        return false;
    }

    try {
        socket.send(JSON.stringify(payload));
        return true;
    } catch (error) {
        return false;
    }
}

function sendAuthentication(type, username, password) {
    pendingAuth = {
        type,
        username,
        password
    };

    authMode = type;

    if (type === "LOGIN" && loginButton) {
        loginButton.disabled = true;
    }

    if (type === "REGISTER" && registerButton) {
        registerButton.disabled = true;
    }

    if (!socket || socket.readyState === WebSocket.CLOSED) {
        connectSocket();
        return;
    }

    if (socket.readyState === WebSocket.OPEN) {
        sendPendingAuthentication();
    }
}

function sendPendingAuthentication() {
    if (!pendingAuth || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
    }

    const request = pendingAuth;
    pendingAuth = null;
    authMode = request.type;

    sendJson({
        type: request.type,
        username: request.username,
        password: request.password
    });
}


// =====================================
// CONVERSATIONS
// =====================================

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
        text: message.text ?? message.content ?? "",
        to: message.to ?? message.recipient ?? "",
        time: message.time || message.created_at || message.createdAt || "",
        id: message.id
    };
}

function getConversationKeyForMessage(rawMessage) {
    const msg = normalizeMessage(rawMessage);

    const sender = normalizeUser(msg.sender);
    const recipient = normalizeUser(msg.to);
    const me = normalizeUser(currentUser);

    if (!recipient) {
        return "general";
    }

    return sender === me ? recipient : sender;
}

function switchChat(targetKey) {
    activeChat = normalizeUser(targetKey) || "general";

    ensureConversation(activeChat);

    if (activeChat === "general") {
        if (chatAvatarEl) chatAvatarEl.textContent = "P";
        if (chatTitleEl) chatTitleEl.textContent = "General Chat";

        if (chatSubtitleEl) {
            chatSubtitleEl.textContent = "Welcome to the PyChat community";
        }

        if (leaveButton) {
            leaveButton.classList.add("hidden");
        }
    } else {
        if (chatAvatarEl) {
            chatAvatarEl.textContent =
                (activeChat[0] || "U").toUpperCase();
        }

        if (chatTitleEl) {
            chatTitleEl.textContent = activeChat;
        }

        const isOnline = onlineUsers.some(
            user => normalizeUser(user) === activeChat
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

    const query = userSearchInput
        ? userSearchInput.value.trim().toLowerCase()
        : "";

    conversationListEl.innerHTML = "";

    const keys = Object.keys(conversations).filter(
        key => key !== "general"
    );

    const onlineOthers = onlineUsers
        .map(user => normalizeUser(user))
        .filter(user => user && user !== normalizeUser(currentUser));

    const allPeers = Array.from(
        new Set([...keys, ...onlineOthers])
    ).filter(peer => !query || peer.includes(query));

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

    generalLi.appendChild(generalAvatar);
    generalLi.appendChild(generalLabel);

    generalLi.addEventListener("click", () => {
        switchChat("general");
    });

    conversationListEl.appendChild(generalLi);

    allPeers.forEach(peer => {
        const li = document.createElement("li");

        li.className =
            "online-user-item" +
            (activeChat === peer ? " active" : "");

        li.style.cursor = "pointer";

        const avatar = document.createElement("span");
        avatar.className = "user-avatar";
        avatar.textContent = (peer[0] || "U").toUpperCase();

        const label = document.createElement("span");
        label.className = "online-user-label";
        label.textContent = peer;

        li.appendChild(avatar);
        li.appendChild(label);

        li.addEventListener("click", () => {
            switchChat(peer);
        });

        conversationListEl.appendChild(li);
    });
}


// =====================================
// ONLINE USERS
// =====================================

function appendMention(username) {
    if (!messageInput || messageInput.disabled) return;

    const prefix =
        messageInput.value && !messageInput.value.endsWith(" ")
            ? " "
            : "";

    messageInput.value += prefix + "@" + username + " ";
    messageInput.focus();
}

function createOnlineChip(username, compact) {
    const cleanName = normalizeUser(username);

    const chip = document.createElement("div");
    chip.className = "online-user-chip";
    chip.style.cursor = "pointer";
    chip.title = cleanName + " bilan shaxsiy chat ochish";

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
    mentionBtn.style.border = "none";
    mentionBtn.style.background = "transparent";
    mentionBtn.style.fontWeight = "700";
    mentionBtn.style.cursor = "pointer";
    mentionBtn.style.padding = "0 2px";

    mentionBtn.addEventListener("click", event => {
        event.stopPropagation();
        appendMention(cleanName);
    });

    const dot = document.createElement("span");
    dot.className = "online-indicator";

    chip.appendChild(avatar);
    chip.appendChild(nameEl);
    chip.appendChild(mentionBtn);
    chip.appendChild(dot);

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

    const query = userSearchInput
        ? userSearchInput.value.trim().toLowerCase()
        : "";

    const filtered = onlineUsers.filter(user =>
        String(user).toLowerCase().includes(query)
    );

    const countLabel = onlineUsers.length + " online";

    if (userCountEl) {
        userCountEl.textContent = String(onlineUsers.length);
    }

    if (topOnlineCountEl) {
        topOnlineCountEl.textContent = String(onlineUsers.length);
    }

    if (onlineNowCountEl) {
        onlineNowCountEl.textContent = countLabel;
    }

    if (topOnlineUsersEl) {
        topOnlineUsersEl.innerHTML = "";

        if (!filtered.length) {
            const empty = document.createElement("span");
            empty.className = "top-online-empty";
            empty.textContent = "No one online right now";
            topOnlineUsersEl.appendChild(empty);
        } else {
            filtered.forEach(user => {
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
                "Hozircha online foydalanuvchilar yo'q";

            onlineNowUsersEl.appendChild(empty);
        } else {
            filtered.forEach(user => {
                onlineNowUsersEl.appendChild(
                    createOnlineChip(user, true)
                );
            });
        }
    }

    if (userListEl) {
        userListEl.innerHTML = "";

        filtered.forEach(user => {
            const li = document.createElement("li");
            li.className = "online-user-item";
            li.style.cursor = "pointer";

            const avatar = document.createElement("span");
            avatar.className = "user-avatar";
            avatar.textContent =
                (String(user)[0] || "U").toUpperCase();

            const label = document.createElement("span");
            label.className = "online-user-label";
            label.textContent = user;

            const dot = document.createElement("span");
            dot.className = "online-indicator";

            li.appendChild(avatar);
            li.appendChild(label);
            li.appendChild(dot);

            li.addEventListener("click", () => {
                if (
                    normalizeUser(user) !==
                    normalizeUser(currentUser)
                ) {
                    switchChat(normalizeUser(user));
                }
            });

            userListEl.appendChild(li);
        });
    }

    if (activeChat !== "general" && chatSubtitleEl) {
        const isOnline = onlineUsers.some(
            user => normalizeUser(user) === activeChat
        );

        chatSubtitleEl.textContent = isOnline
            ? "Private chat • Online"
            : "Private chat • Offline";
    }

    renderConversationsSidebar();
}


// =====================================
// MESSAGES
// =====================================

function appendMessageElement(rawMessage) {
    if (!messagesContainer) return;

    const msg = normalizeMessage(rawMessage);

    if (emptyStateEl) {
        emptyStateEl.classList.add("hidden");
    }

    const isMine =
        normalizeUser(msg.sender) === normalizeUser(currentUser);

    const wrapper = document.createElement("div");
    wrapper.className = "message" + (isMine ? " mine" : "");

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const timeStr = formatTime(msg.time);

    meta.textContent = timeStr
        ? msg.sender + " • " + timeStr
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

    wrapper.appendChild(meta);
    wrapper.appendChild(bubble);

    messagesContainer.appendChild(wrapper);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function renderActiveMessages() {
    if (!messagesContainer) return;

    const list = ensureConversation(activeChat);

    messagesContainer.innerHTML = "";

    if (!list.length) {
        if (emptyStateEl) {
            emptyStateEl.classList.remove("hidden");
            messagesContainer.appendChild(emptyStateEl);
        }

        return;
    }

    if (emptyStateEl) {
        emptyStateEl.classList.add("hidden");
    }

    list.forEach(message => {
        appendMessageElement(message);
    });
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

function loadMessageHistory(messages) {
    conversations = { general: [] };

    if (!Array.isArray(messages)) {
        renderActiveMessages();
        return;
    }

    messages.forEach(rawMessage => {
        const msg = normalizeMessage(rawMessage);
        const key = getConversationKeyForMessage(msg);

        ensureConversation(key).push(msg);
    });

    renderConversationsSidebar();
    renderActiveMessages();
}

function sendCurrentMessage(customContent) {
    if (!joined || !currentUser || !messageInput) return;

    const text =
        customContent !== undefined && customContent !== null
            ? customContent
            : messageInput.value.trim();

    if (!text) return;

    const recipient =
        activeChat === "general" ? null : activeChat;

    const sent = sendJson({
        type: "MESSAGE",
        text: text,
        content: text,
        to: recipient,
        recipient: recipient
    });

    if (sent && (customContent === undefined || customContent === null)) {
        messageInput.value = "";
        messageInput.focus();
    }
}


// =====================================
// SERVER PACKET HANDLER
// Matches server.py:
// WELCOME, HISTORY, USERS, MESSAGE, ERROR
// =====================================

function handleServerMessage(data) {
    if (!data || !data.type) return;

    switch (data.type) {

        case "WELCOME": {
            joined = true;
            reconnectAttempts = 0;
            authMode = null;

            if (data.token) {
                localStorage.setItem(
                    SESSION_STORAGE_KEY,
                    data.token
                );
            }

            if (data.username) {
                showChatScreen(data.username);
            }

            if (loginErrorEl) loginErrorEl.textContent = "";
            if (registerErrorEl) registerErrorEl.textContent = "";

            setConnectionStatus("online", "Connected");
            updateSendAvailability();
            break;
        }

        case "HISTORY": {
            loadMessageHistory(
                data.messages || data.history || []
            );
            break;
        }

        case "USERS": {
            renderOnlineUsers(data.users || []);
            break;
        }

        case "MESSAGE": {
            ingestMessage(data);
            break;
        }

        case "ERROR": {
            const message =
                data.message || "Authentication failed.";

            if (!joined) {
                if (authMode === "REGISTER") {
                    if (registerErrorEl) {
                        registerErrorEl.textContent = message;
                    }
                } else {
                    if (loginErrorEl) {
                        loginErrorEl.textContent = message;
                    }
                }

                // Invalid saved session should not be retried forever.
                if (authMode === "RESUME") {
                    localStorage.removeItem(SESSION_STORAGE_KEY);
                    showAuthScreen();
                }

                pendingAuth = null;
                authMode = null;
                resetAuthButtons();
            } else {
                alert(message);
            }

            break;
        }

        case "PONG":
            break;

        case "MESSAGE_DELETED": {
            const targetId = data.id;

            Object.keys(conversations).forEach(key => {
                conversations[key] = conversations[key].filter(
                    message => message.id !== targetId
                );
            });

            renderActiveMessages();
            break;
        }

        default:
            break;
    }
}


// =====================================
// CONNECT / AUTO RESUME / RECONNECT
// =====================================

function connectSocket() {
    if (
        socket &&
        (
            socket.readyState === WebSocket.OPEN ||
            socket.readyState === WebSocket.CONNECTING
        )
    ) {
        return;
    }

    clearTimeout(reconnectTimer);

    setConnectionStatus("connecting", "Connecting...");

    let newSocket;

    try {
        newSocket = new WebSocket(WS_URL);
    } catch (error) {
        setConnectionStatus("offline", "Disconnected");
        scheduleReconnect();
        return;
    }

    socket = newSocket;

    newSocket.addEventListener("open", () => {
        if (socket !== newSocket) return;

        reconnectAttempts = 0;
        setConnectionStatus("online", "Connected");

        // If the user submitted login/register while disconnected,
        // send that request as soon as the socket opens.
        if (pendingAuth) {
            sendPendingAuthentication();
        } else if (!joined && !manuallyLoggedOut) {
            const savedToken = localStorage.getItem(
                SESSION_STORAGE_KEY
            );

            if (savedToken) {
                authMode = "RESUME";

                sendJson({
                    type: "RESUME",
                    token: savedToken
                });
            } else {
                showAuthScreen();
            }
        }

        updateSendAvailability();

        clearInterval(pingTimer);

        pingTimer = setInterval(() => {
            if (joined) {
                sendJson({ type: "PING" });
            }
        }, 25000);
    });

    newSocket.addEventListener("message", event => {
        if (socket !== newSocket) return;

        let data;

        try {
            data = JSON.parse(event.data);
        } catch (error) {
            return;
        }

        handleServerMessage(data);
    });

    newSocket.addEventListener("close", () => {
        if (socket !== newSocket) return;

        clearInterval(pingTimer);

        joined = false;
        updateSendAvailability();

        if (manuallyLoggedOut) {
            setConnectionStatus("offline", "Disconnected");
            return;
        }

        setConnectionStatus("offline", "Reconnecting...");

        scheduleReconnect();
    });

    newSocket.addEventListener("error", () => {
        if (socket !== newSocket) return;

        setConnectionStatus("offline", "Disconnected");
    });
}

function scheduleReconnect() {
    if (manuallyLoggedOut) return;

    clearTimeout(reconnectTimer);

    reconnectAttempts++;

    const delay = Math.min(
        2500 + reconnectAttempts * 1000,
        10000
    );

    reconnectTimer = setTimeout(() => {
        connectSocket();
    }, delay);
}


// =====================================
// LOGIN
// =====================================

if (loginForm) {
    loginForm.addEventListener("submit", event => {
        event.preventDefault();

        if (loginErrorEl) {
            loginErrorEl.textContent = "";
        }

        const username = loginUsernameInput
            ? loginUsernameInput.value.trim()
            : "";

        const password = loginPasswordInput
            ? loginPasswordInput.value
            : "";

        if (!username || !password) {
            if (loginErrorEl) {
                loginErrorEl.textContent =
                    "Username va parolni kiriting.";
            }

            return;
        }

        manuallyLoggedOut = false;

        sendAuthentication("LOGIN", username, password);
    });
}


// =====================================
// REGISTER
// =====================================

if (registerForm) {
    registerForm.addEventListener("submit", event => {
        event.preventDefault();

        if (registerErrorEl) {
            registerErrorEl.textContent = "";
        }

        const username = registerUsernameInput
            ? registerUsernameInput.value.trim()
            : "";

        const password = registerPasswordInput
            ? registerPasswordInput.value
            : "";

        const confirmPassword = confirmPasswordInput
            ? confirmPasswordInput.value
            : "";

        if (!username || password.length < 8) {
            if (registerErrorEl) {
                registerErrorEl.textContent =
                    "Username kiriting va parol kamida 8 belgi bo'lsin.";
            }

            return;
        }

        if (
            confirmPasswordInput &&
            password !== confirmPassword
        ) {
            if (registerErrorEl) {
                registerErrorEl.textContent =
                    "Parollar bir xil emas.";
            }

            return;
        }

        manuallyLoggedOut = false;

        sendAuthentication("REGISTER", username, password);
    });
}


// =====================================
// SHOW REGISTER / LOGIN
// =====================================

if (showRegisterBtn) {
    showRegisterBtn.addEventListener("click", () => {
        if (loginForm) loginForm.classList.add("hidden");
        if (registerForm) registerForm.classList.remove("hidden");

        if (loginErrorEl) loginErrorEl.textContent = "";
        if (registerErrorEl) registerErrorEl.textContent = "";
    });
}

if (showLoginBtn) {
    showLoginBtn.addEventListener("click", () => {
        if (registerForm) registerForm.classList.add("hidden");
        if (loginForm) loginForm.classList.remove("hidden");

        if (loginErrorEl) loginErrorEl.textContent = "";
        if (registerErrorEl) registerErrorEl.textContent = "";
    });
}


// =====================================
// PASSWORD VISIBILITY
// =====================================

if (toggleLoginPasswordBtn) {
    toggleLoginPasswordBtn.addEventListener("click", () => {
        if (!loginPasswordInput) return;

        const isPassword =
            loginPasswordInput.type === "password";

        loginPasswordInput.type = isPassword ? "text" : "password";

        toggleLoginPasswordBtn.textContent =
            isPassword ? "Hide" : "Show";
    });
}

if (toggleRegisterPasswordBtn) {
    toggleRegisterPasswordBtn.addEventListener("click", () => {
        if (!registerPasswordInput) return;

        const isPassword =
            registerPasswordInput.type === "password";

        registerPasswordInput.type = isPassword ? "text" : "password";

        toggleRegisterPasswordBtn.textContent =
            isPassword ? "Hide" : "Show";
    });
}


// =====================================
// PROFILE MENU
// =====================================

if (profileMenuButton) {
    profileMenuButton.addEventListener("click", event => {
        event.stopPropagation();

        if (profileMenuEl) {
            profileMenuEl.classList.toggle("hidden");
        }
    });
}

document.addEventListener("click", () => {
    if (profileMenuEl) {
        profileMenuEl.classList.add("hidden");
    }
});


// =====================================
// LOGOUT
// =====================================

if (logoutButton) {
    logoutButton.addEventListener("click", () => {
        manuallyLoggedOut = true;

        sendJson({
            type: "LOGOUT",
            token: localStorage.getItem(SESSION_STORAGE_KEY)
        });

        localStorage.removeItem(SESSION_STORAGE_KEY);

        clearTimeout(reconnectTimer);
        clearInterval(pingTimer);

        pendingAuth = null;
        authMode = null;
        currentUser = null;
        joined = false;

        if (socket) {
            const oldSocket = socket;
            socket = null;
            oldSocket.close();
        }

        showAuthScreen();
        setConnectionStatus("offline", "Disconnected");
    });
}


// =====================================
// CHAT CONTROLS
// =====================================

if (leaveButton) {
    leaveButton.addEventListener("click", () => {
        switchChat("general");
    });
}

if (userSearchInput) {
    userSearchInput.addEventListener("input", () => {
        renderOnlineUsers(onlineUsers);
    });
}

if (sendButton) {
    sendButton.addEventListener("click", () => {
        sendCurrentMessage();
    });
}

if (messageInput) {
    messageInput.addEventListener("keydown", event => {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            sendCurrentMessage();
        }
    });
}


// =====================================
// IMAGE UPLOAD
// =====================================

if (attachButton) {
    attachButton.addEventListener("click", () => {
        if (
            messageInput &&
            !messageInput.disabled &&
            fileUploadInput
        ) {
            fileUploadInput.click();
        }
    });
}

if (fileUploadInput) {
    fileUploadInput.addEventListener("change", () => {
        const file =
            fileUploadInput.files &&
            fileUploadInput.files[0];

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

        reader.readAsDataURL(file);
    });
}


// =====================================
// START
// =====================================

connectSocket();
