const WS_URL = "wss://pychat-8gdk.onrender.com";
const SESSION_STORAGE_KEY = "pychat_session_token";

// DOM Elements
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

// Application State
let socket = null;
let reconnectTimer = null;
let pingTimer = null;
let currentUser = null;
let joined = false;
let onlineUsers = [];
let activeChat = "general";
let conversations = {
    general: []
};

function normalizeUser(name) {
    return (name || "").trim().toLowerCase();
}

function formatTime(isoString) {
    if (!isoString) {
        return "";
    }
    const date = new Date(isoString);
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

function updateSendAvailability() {
    const canSend = Boolean(
        socket &&
        socket.readyState === WebSocket.OPEN &&
        currentUser &&
        joined
    );
    if (messageInput) {
        messageInput.disabled = !canSend;
    }
    if (sendButton) {
        sendButton.disabled = !canSend;
    }
    if (attachButton) {
        attachButton.disabled = !canSend;
    }
}

function resetAuthButtons() {
    if (loginButton) {
        loginButton.disabled = false;
    }
    if (registerButton) {
        registerButton.disabled = false;
    }
}

function showAuthScreen() {
    if (loginScreen) {
        loginScreen.classList.remove("hidden");
    }
    if (chatScreen) {
        chatScreen.classList.add("hidden");
    }
    joined = false;
    resetAuthButtons();
    updateSendAvailability();
}

function showChatScreen(username) {
    currentUser = username;
    if (loginScreen) {
        loginScreen.classList.add("hidden");
    }
    if (chatScreen) {
        chatScreen.classList.remove("hidden");
    }
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

function ensureConversation(key) {
    if (!conversations[key]) {
        conversations[key] = [];
    }
    return conversations[key];
}

function getConversationKeyForMessage(msg) {
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
        if (chatAvatarEl) {
            chatAvatarEl.textContent = "P";
        }
        if (chatTitleEl) {
            chatTitleEl.textContent = "General Chat";
        }
        if (chatSubtitleEl) {
            chatSubtitleEl.textContent = "Welcome to the PyChat community";
        }
        if (leaveButton) {
            leaveButton.classList.add("hidden");
        }
    } else {
        if (chatAvatarEl) {
            chatAvatarEl.textContent = (activeChat[0] || "U").toUpperCase();
        }
        if (chatTitleEl) {
            chatTitleEl.textContent = activeChat;
        }
        const isOnline = onlineUsers.some(
            (u) => normalizeUser(u) === activeChat
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
    if (!conversationListEl) {
        return;
    }
    const query = (userSearchInput ? userSearchInput.value : "")
        .trim()
        .toLowerCase();
    conversationListEl.innerHTML = "";

    const keys = Object.keys(conversations).filter((k) => k !== "general");
    const onlineOthers = onlineUsers
        .map((u) => normalizeUser(u))
        .filter((u) => u && u !== normalizeUser(currentUser));

    const allPeers = Array.from(new Set([...keys, ...onlineOthers])).filter(
        (peer) => !query || peer.includes(query)
    );

    const generalLi = document.createElement("li");
    generalLi.className = `online-user-item ${activeChat === "general" ? "active" : ""}`;
    generalLi.style.cursor = "pointer";

    const generalAvatar = document.createElement("span");
    generalAvatar.className = "user-avatar";
    generalAvatar.textContent = "P";

    const generalLabel = document.createElement("span");
    generalLabel.className = "online-user-label";
    generalLabel.textContent = "General Chat";

    generalLi.appendChild(generalAvatar);
    generalLi.appendChild(generalLabel);
    generalLi.addEventListener("click", () => switchChat("general"));
    conversationListEl.appendChild(generalLi);

    allPeers.forEach((peer) => {
        const li = document.createElement("li");
        li.className = `online-user-item ${activeChat === peer ? "active" : ""}`;
        li.style.cursor = "pointer";

        const avatar = document.createElement("span");
        avatar.className = "user-avatar";
        avatar.textContent = (peer[0] || "U").toUpperCase();

        const label = document.createElement("span");
        label.className = "online-user-label";
        label.textContent = peer;

        li.appendChild(avatar);
        li.appendChild(label);
        li.addEventListener("click", () => switchChat(peer));
        conversationListEl.appendChild(li);
    });
}

function appendMention(username) {
    if (!messageInput || messageInput.disabled) {
        return;
    }
    const prefix =
        messageInput.value && !messageInput.value.endsWith(" ") ? " " : "";
    messageInput.value = `${messageInput.value}${prefix}@${username} `;
    messageInput.focus();
}

function createOnlineChip(username, compact = false) {
    const cleanName = normalizeUser(username);
    const chip = document.createElement("div");
    chip.className = "online-user-chip";
    chip.style.cursor = "pointer";
    chip.title = `${cleanName} bilan shaxsiy chat ochish`;

    const avatar = document.createElement("span");
    avatar.className = compact ? "online-user-avatar" : "user-avatar";
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
    mentionBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        appendMention(cleanName);
    });

    const dot = document.createElement("span");
    dot.className = "online-indicator";

    chip.appendChild(avatar);
    chip.appendChild(nameEl);
    chip.appendChild(mentionBtn);
    chip.appendChild(dot);

    chip.addEventListener("click", () => {
        if (cleanName && cleanName !== normalizeUser(currentUser)) {
            switchChat(cleanName);
        }
    });

    return chip;
}

function renderOnlineUsers(users) {
    onlineUsers = Array.isArray(users) ? users : [];
    const query = (userSearchInput ? userSearchInput.value : "")
        .trim()
        .toLowerCase();
    const filtered = onlineUsers.filter(
        (u) => !query || u.toLowerCase().includes(query)
    );
    const countLabel = `${onlineUsers.length} online`;

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
            const emptySpan = document.createElement("span");
            emptySpan.className = "top-online-empty";
            emptySpan.textContent = "No one online right now";
            topOnlineUsersEl.appendChild(emptySpan);
        } else {
            filtered.forEach((u) => {
                topOnlineUsersEl.appendChild(createOnlineChip(u, false));
            });
        }
    }

    if (onlineNowUsersEl) {
        onlineNowUsersEl.innerHTML = "";
        if (!filtered.length) {
            const emptySpan = document.createElement("span");
            emptySpan.className = "top-online-empty";
            emptySpan.textContent = "Hozircha online foydalanuvchilar yo‘q";
            onlineNowUsersEl.appendChild(emptySpan);
        } else {
            filtered.forEach((u) => {
                onlineNowUsersEl.appendChild(createOnlineChip(u, true));
            });
        }
    }

    if (userListEl) {
        userListEl.innerHTML = "";
        filtered.forEach((u) => {
            const li = document.createElement("li");
            li.className = "online-user-item";
            li.style.cursor = "pointer";

            const avatar = document.createElement("span");
            avatar.className = "user-avatar";
            avatar.textContent = (u[0] || "U").toUpperCase();

            const label = document.createElement("span");
            label.className = "online-user-label";
            label.textContent = u;

            const dot = document.createElement("span");
            dot.className = "online-indicator";

            li.appendChild(avatar);
            li.appendChild(label);
            li.appendChild(dot);

            li.addEventListener("click", () => {
                if (normalizeUser(u) !== normalizeUser(currentUser)) {
                    switchChat(normalizeUser(u));
                }
            });
            userListEl.appendChild(li);
        });
    }

    if (activeChat !== "general" && chatSubtitleEl) {
        const isOnline = onlineUsers.some(
            (u) => normalizeUser(u) === activeChat
        );
        chatSubtitleEl.textContent = isOnline
            ? "Private chat • Online"
            : "Private chat • Offline";
    }

    renderConversationsSidebar();
}

function appendMessageElement(msg) {
    if (!messagesContainer) {
        return;
    }
    if (emptyStateEl) {
        emptyStateEl.classList.add("hidden");
    }

    const isMine = normalizeUser(msg.sender) === normalizeUser(currentUser);
    const wrapper = document.createElement("div");
    wrapper.className = `message ${isMine ? "mine" : ""}`;

    const meta = document.createElement("div");
    meta.className = "message-meta";
    const timeStr = formatTime(msg.time);
    meta.textContent = timeStr ? `${msg.sender} • ${timeStr}` : msg.sender;

    if (isMine && msg.id) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.textContent = "×";
        delBtn.title = "Xabarni o'chirish";
        delBtn.style.marginLeft = "8px";
        delBtn.style.border = "none";
        delBtn.style.background = "transparent";
        delBtn.style.color = "inherit";
        delBtn.style.cursor = "pointer";
        delBtn.style.fontWeight = "700";
        delBtn.addEventListener("click", () => {
            sendJson({ type: "DELETE_MESSAGE", id: msg.id });
        });
        meta.appendChild(delBtn);
    }

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";

    if (typeof msg.text === "string" && msg.text.startsWith("data:image/")) {
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
    if (!messagesContainer) {
        return;
    }
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
    list.forEach((msg) => appendMessageElement(msg));
}

function ingestMessage(msg) {
    const key = getConversationKeyForMessage(msg);
    const list = ensureConversation(key);
    list.push(msg);

    if (key === activeChat) {
        appendMessageElement(msg);
    }
    renderConversationsSidebar();
}

function sendJson(payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
        return true;
    }
    return false;
}

function sendCurrentMessage(customContent = null) {
    if (!joined || !currentUser || !messageInput) {
        return;
    }
    const text =
        customContent !== null ? customContent : messageInput.value.trim();
    if (!text) {
        return;
    }

    const payload = {
        type: "MESSAGE",
        text,
        to: activeChat === "general" ? null : activeChat
    };

    if (sendJson(payload) && customContent === null) {
        messageInput.value = "";
        messageInput.focus();
    }
}

function connectSocket() {
    if (
        socket &&
        (socket.readyState === WebSocket.OPEN ||
            socket.readyState === WebSocket.CONNECTING)
    ) {
        return;
    }

    setConnectionStatus("connecting", "Connecting...");
    socket = new WebSocket(WS_URL);

    socket.addEventListener("open", () => {
        setConnectionStatus("online", "Connected");
        const savedToken = localStorage.getItem(SESSION_STORAGE_KEY);
        if (savedToken) {
            sendJson({ type: "RESUME_SESSION", token: savedToken });
        } else {
            showAuthScreen();
        }
        updateSendAvailability();

        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
            sendJson({ type: "PING" });
        }, 25000);
    });

    socket.addEventListener("message", (event) => {
        let data;
        try {
            data = JSON.parse(event.data);
        } catch {
            return;
        }

        switch (data.type) {
            case "AUTH_OK":
                if (data.token) {
                    localStorage.setItem(SESSION_STORAGE_KEY, data.token);
                }
                if (loginErrorEl) {
                    loginErrorEl.textContent = "";
                }
                if (registerErrorEl) {
                    registerErrorEl.textContent = "";
                }
                conversations = { general: [] };
                showChatScreen(data.username);
                break;

            case "AUTH_ERROR":
                if (loginErrorEl) {
                    loginErrorEl.textContent =
                        data.message || "Authentication failed.";
                }
                if (registerErrorEl) {
                    registerErrorEl.textContent =
                        data.message || "Registration failed.";
                }
                resetAuthButtons();
                break;

            case "SESSION_EXPIRED":
                localStorage.removeItem(SESSION_STORAGE_KEY);
                showAuthScreen();
                break;

            case "WELCOME":
                joined = true;
                updateSendAvailability();
                break;

            case "ONLINE_USERS":
                renderOnlineUsers(data.users || []);
                break;

            case "HISTORY":
                conversations = { general: [] };
                (data.messages || []).forEach((m) => {
                    const key = getConversationKeyForMessage(m);
                    ensureConversation(key).push(m);
                });
                renderConversationsSidebar();
                renderActiveMessages();
                break;

            case "MESSAGE":
                ingestMessage(data);
                break;

            case "MESSAGE_DELETED": {
                const targetId = data.id;
                Object.keys(conversations).forEach((key) => {
                    conversations[key] = conversations[key].filter(
                        (m) => m.id !== targetId
                    );
                });
                renderActiveMessages();
                break;
            }

            case "ERROR":
                alert(data.message || "Error occurred.");
                break;

            default:
                break;
        }
    });

    socket.addEventListener("close", () => {
        clearInterval(pingTimer);
        joined = false;
        updateSendAvailability();
        setConnectionStatus("offline", "Reconnecting...");
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connectSocket, 2500);
    });

    socket.addEventListener("error", () => {
        setConnectionStatus("offline", "Disconnected");
    });
}

// Auth UI Events
if (showRegisterBtn) {
    showRegisterBtn.addEventListener("click", () => {
        if (loginForm) {
            loginForm.classList.add("hidden");
        }
        if (registerForm) {
            registerForm.classList.remove("hidden");
        }
        if (loginErrorEl) {
            loginErrorEl.textContent = "";
        }
        if (registerErrorEl) {
            registerErrorEl.textContent = "";
        }
    });
}

if (showLoginBtn) {
    showLoginBtn.addEventListener("click", () => {
        if (registerForm) {
            registerForm.classList.add("hidden");
        }
        if (loginForm) {
            loginForm.classList.remove("hidden");
        }
        if (loginErrorEl) {
            loginErrorEl.textContent = "";
        }
        if (registerErrorEl) {
            registerErrorEl.textContent = "";
        }
    });
}

if (toggleLoginPasswordBtn) {
    toggleLoginPasswordBtn.addEventListener("click", () => {
        if (!loginPasswordInput) {
            return;
        }
        const isPass = loginPasswordInput.type === "password";
        loginPasswordInput.type = isPass ? "text" : "password";
        toggleLoginPasswordBtn.textContent = isPass ? "Hide" : "Show";
    });
}

if (toggleRegisterPasswordBtn) {
    toggleRegisterPasswordBtn.addEventListener("click", () => {
        if (!registerPasswordInput) {
            return;
        }
        const isPass = registerPasswordInput.type === "password";
        registerPasswordInput.type = isPass ? "text" : "password";
        toggleRegisterPasswordBtn.textContent = isPass ? "Hide" : "Show";
    });
}

if (loginForm) {
    loginForm.addEventListener("submit", (e) => {
        e.preventDefault();
        if (loginErrorEl) {
            loginErrorEl.textContent = "";
        }
        const username = (loginUsernameInput ? loginUsernameInput.value : "").trim();
        const password = loginPasswordInput ? loginPasswordInput.value : "";

        if (!username || !password) {
            if (loginErrorEl) {
                loginErrorEl.textContent = "Username va parolni kiriting.";
            }
            return;
        }
        if (!sendJson({ type: "LOGIN", username, password })) {
            if (loginErrorEl) {
                loginErrorEl.textContent =
                    "Server bilan aloqa yo'q. Qayta ulanilmoqda...";
            }
            connectSocket();
        }
    });
}

if (registerForm) {
    registerForm.addEventListener("submit", (e) => {
        e.preventDefault();
        if (registerErrorEl) {
            registerErrorEl.textContent = "";
        }
        const username = (
            registerUsernameInput ? registerUsernameInput.value : ""
        ).trim();
        const password = registerPasswordInput ? registerPasswordInput.value : "";
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
        if (confirmPasswordInput && password !== confirmPassword) {
            if (registerErrorEl) {
                registerErrorEl.textContent = "Parollar bir xil emas.";
            }
            return;
        }
        if (!sendJson({ type: "REGISTER", username, password })) {
            if (registerErrorEl) {
                registerErrorEl.textContent =
                    "Server bilan aloqa yo'q. Qayta ulanilmoqda...";
            }
            connectSocket();
        }
    });
}

// Profile Menu & Logout
if (profileMenuButton) {
    profileMenuButton.addEventListener("click", (e) => {
        e.stopPropagation();
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

if (logoutButton) {
    logoutButton.addEventListener("click", () => {
        const token = localStorage.getItem(SESSION_STORAGE_KEY);
        sendJson({ type: "LOGOUT", token });
        localStorage.removeItem(SESSION_STORAGE_KEY);
        currentUser = null;
        joined = false;
        showAuthScreen();
    });
}

// Chat Events
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
    sendButton.addEventListener("click", () => sendCurrentMessage());
}

if (messageInput) {
    messageInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            sendCurrentMessage();
        }
    });
}

if (attachButton) {
    attachButton.addEventListener("click", () => {
        if (messageInput && !messageInput.disabled && fileUploadInput) {
            fileUploadInput.click();
        }
    });
}

if (fileUploadInput) {
    fileUploadInput.addEventListener("change", () => {
        const file = fileUploadInput.files && fileUploadInput.files[0];
        if (!file) {
            return;
        }
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

// Start
connectSocket();