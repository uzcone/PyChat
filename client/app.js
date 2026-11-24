
"use strict";

// =====================================
// PYCHAT — WEBSOCKET CLIENT
// =====================================

const SERVER_URL = "wss://pychat-8gdk.onrender.com";

let socket = null;
let username = "";
let joined = false;
let pendingResolve = null;
let pendingReject = null;

// =====================================
// HTML ELEMENTS
// =====================================

// Screens
const loginScreen = document.getElementById("loginScreen");
const chatScreen = document.getElementById("chatScreen");

// Authentication
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
const showLogin = document.getElementById("showLogin");

const authTitle = document.getElementById("authTitle");
const authSubtitle = document.getElementById("authSubtitle");

// Password visibility
const toggleLoginPassword =
    document.getElementById("toggleLoginPassword");

const toggleRegisterPassword =
    document.getElementById("toggleRegisterPassword");

// Chat
const messages = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");

const userList = document.getElementById("userList");
const userCount = document.getElementById("userCount");

const statusDot = document.getElementById("statusDot");
const connectionStatus =
    document.getElementById("connectionStatus");

const myUsername = document.getElementById("myUsername");
const myAvatar = document.getElementById("myAvatar");
const myAvatarImage = document.getElementById("myAvatarImage");

const leaveButton = document.getElementById("leaveButton");
const logoutButton = document.getElementById("logoutButton");

// Profile
const profileMenuButton =
    document.getElementById("profileMenuButton");

const profileMenu = document.getElementById("profileMenu");
const changeAvatarButton =
    document.getElementById("changeAvatarButton");

const avatarUpload = document.getElementById("avatarUpload");

// Other chat elements
const userSearch = document.getElementById("userSearch");
const conversationList =
    document.getElementById("conversationList");

const chatTitle = document.getElementById("chatTitle");
const chatSubtitle = document.getElementById("chatSubtitle");


// =====================================
// CONNECTION STATUS
// =====================================

function setStatus(online, text) {
    statusDot.classList.toggle("online", online);
    connectionStatus.textContent = text;
}


// =====================================
// AUTH SCREEN SWITCHING
// =====================================

function showLoginForm() {
    loginForm.classList.remove("hidden");
    registerForm.classList.add("hidden");

    authTitle.textContent = "Welcome back";
    authSubtitle.textContent = "Sign in to continue to PyChat";

    loginError.textContent = "";
    registerError.textContent = "";
}

function showRegisterForm() {
    loginForm.classList.add("hidden");
    registerForm.classList.remove("hidden");

    authTitle.textContent = "Create account";
    authSubtitle.textContent = "Join the PyChat community";

    loginError.textContent = "";
    registerError.textContent = "";
}


// =====================================
// PASSWORD VISIBILITY
// =====================================

function togglePassword(input, button) {
    if (!input || !button) return;

    const visible = input.type === "password";

    input.type = visible ? "text" : "password";
    button.textContent = visible ? "Hide" : "Show";
    button.setAttribute(
        "aria-label",
        visible ? "Hide password" : "Show password"
    );
}


// =====================================
// CONNECT AND AUTHENTICATE
// =====================================

function connectAndAuthenticate(type, credentials) {
    return new Promise((resolve, reject) => {

        if (socket) {
            socket.close();
            socket = null;
        }

        if (!SERVER_URL.startsWith("wss://")) {
            reject(new Error("Invalid server URL."));
            return;
        }

        let settled = false;

        pendingResolve = resolve;
        pendingReject = reject;

        const ws = new WebSocket(SERVER_URL);
        socket = ws;

        function fail(error) {
            if (settled) return;

            settled = true;
            pendingResolve = null;
            pendingReject = null;

            reject(error);
        }

        ws.onopen = () => {
            setStatus(true, "Connected");

            ws.send(JSON.stringify({
                type: type,
                ...credentials
            }));
        };

        ws.onmessage = (event) => {
            let packet;

            try {
                packet = JSON.parse(event.data);
            } catch {
                return;
            }

            handlePacket(packet, () => {
                if (settled) return;

                settled = true;
                pendingResolve = null;
                pendingReject = null;

                resolve(true);
            }, fail);
        };

        ws.onerror = () => {
            setStatus(false, "Connection error");
            fail(new Error("Unable to connect to PyChat server."));
        };

        ws.onclose = () => {
            setStatus(false, "Offline");

            if (!settled) {
                fail(new Error("Server connection closed."));
            }

            if (joined) {
                joined = false;
                showLogin();

                loginError.textContent =
                    "Connection lost. Please sign in again.";
            }

            if (socket === ws) {
                socket = null;
            }
        };

    });
}


// =====================================
// HANDLE SERVER PACKETS
// =====================================

function handlePacket(packet, onSuccess, onError) {

    switch (packet.type) {

        case "WELCOME":

            joined = true;

            username = packet.username || username;

            myUsername.textContent = username;
            myAvatar.textContent =
                username.charAt(0).toUpperCase();

            loginScreen.classList.add("hidden");
            chatScreen.classList.remove("hidden");

            chatTitle.textContent = "General Chat";
            chatSubtitle.textContent =
                "Welcome to the PyChat community";

            addNotice(packet.message || "Welcome to PyChat!");

            onSuccess();
            break;


        case "MESSAGE":

            addMessage(
                packet.username,
                packet.message
            );

            break;


        case "NOTICE":

            addNotice(packet.message);
            break;


        case "USERS":

            updateUsers(packet.users || []);

            userCount.textContent =
                packet.count ?? (packet.users || []).length;

            break;


        case "ERROR":

            if (!joined) {
                onError(
                    new Error(packet.message || "Authentication failed.")
                );
            } else {
                addNotice("Error: " + packet.message);
            }

            break;


        case "PONG":
            break;
    }
}


// =====================================
// LOGIN
// =====================================

async function login() {

    const name = loginUsername.value.trim();
    const password = loginPassword.value;

    loginError.textContent = "";

    if (!name || !password) {
        loginError.textContent =
            "Please enter your username and password.";
        return;
    }

    if (name.length < 3 || name.length > 30) {
        loginError.textContent =
            "Username must be 3–30 characters.";
        return;
    }

    username = name;

    loginButton.disabled = true;
    loginButton.textContent = "Signing in...";

    try {
        await connectAndAuthenticate("LOGIN", {
            username: name,
            password: password
        });

        loginPassword.value = "";

    } catch (error) {
        loginError.textContent = error.message;

        if (socket) {
            socket.close();
        }

    } finally {
        loginButton.disabled = false;
        loginButton.textContent = "Sign In";
    }
}


// =====================================
// REGISTER
// =====================================

async function register() {

    const name = registerUsername.value.trim();
    const password = registerPassword.value;
    const confirmation = confirmPassword.value;

    registerError.textContent = "";

    if (!name || !password || !confirmation) {
        registerError.textContent =
            "Please complete all fields.";
        return;
    }

    if (!/^[a-zA-Z0-9_]{3,30}$/.test(name)) {
        registerError.textContent =
            "Use 3–30 letters, numbers or underscores.";
        return;
    }

    if (password.length < 8) {
        registerError.textContent =
            "Password must contain at least 8 characters.";
        return;
    }

    if (password !== confirmation) {
        registerError.textContent =
            "Passwords do not match.";
        return;
    }

    username = name;

    registerButton.disabled = true;
    registerButton.textContent = "Creating account...";

    try {
        await connectAndAuthenticate("REGISTER", {
            username: name,
            password: password
        });

        registerPassword.value = "";
        confirmPassword.value = "";

    } catch (error) {
        registerError.textContent = error.message;

        if (socket) {
            socket.close();
        }

    } finally {
        registerButton.disabled = false;
        registerButton.textContent = "Create Account";
    }
}


// =====================================
// SEND MESSAGE
// =====================================

function sendMessage() {

    const text = messageInput.value.trim();

    if (!text || !joined) return;

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

    const emptyState =
        messages.querySelector(".empty-state");

    if (emptyState) {
        emptyState.remove();
    }

    const message = document.createElement("div");

    message.className = "message" +
        (sender === username ? " mine" : "");

    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = sender;

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.textContent = text;

    message.appendChild(meta);
    message.appendChild(bubble);

    messages.appendChild(message);

    messages.scrollTop = messages.scrollHeight;
}


// =====================================
// SYSTEM NOTICE
// =====================================

function addNotice(text) {

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

    userList.replaceChildren();

    users.forEach(user => {

        const name = typeof user === "string"
            ? user
            : user.username;

        if (!name) return;

        const li = document.createElement("li");

        const avatar = document.createElement("div");
        avatar.className = "user-avatar";
        avatar.textContent = name.charAt(0).toUpperCase();

        const label = document.createElement("span");
        label.textContent = name;

        const indicator = document.createElement("span");
        indicator.className = "online-indicator";

        li.appendChild(avatar);
        li.appendChild(label);
        li.appendChild(indicator);

        userList.appendChild(li);
    });
}


// =====================================
// AVATAR PREVIEW
// =====================================

avatarUpload.addEventListener("change", () => {

    const file = avatarUpload.files[0];

    if (!file) return;

    if (!file.type.startsWith("image/")) {
        alert("Please select an image.");
        return;
    }

    if (file.size > 5 * 1024 * 1024) {
        alert("Image must be smaller than 5 MB.");
        avatarUpload.value = "";
        return;
    }

    const reader = new FileReader();

    reader.onload = () => {
        myAvatarImage.src = reader.result;
        myAvatarImage.classList.remove("hidden");
        myAvatar.classList.add("hidden");
    };

    reader.readAsDataURL(file);
});


// =====================================
// PROFILE MENU
// =====================================

profileMenuButton.addEventListener("click", () => {
    profileMenu.classList.toggle("hidden");
});

changeAvatarButton.addEventListener("click", () => {
    profileMenu.classList.add("hidden");
    avatarUpload.click();
});


// =====================================
// LOGOUT / LEAVE
// =====================================

function leaveChat() {

    joined = false;

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: "LEAVE"
        }));

        socket.close();
    }

    socket = null;

    showLogin();
}

function logout() {
    leaveChat();

    loginPassword.value = "";
    loginUsername.value = "";

    profileMenu.classList.add("hidden");

    myAvatarImage.classList.add("hidden");
    myAvatar.classList.remove("hidden");

    showLoginForm();
}


// =====================================
// SHOW LOGIN SCREEN
// =====================================

function showLogin() {

    loginScreen.classList.remove("hidden");
    chatScreen.classList.add("hidden");

    setStatus(false, "Offline");

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

    userList.replaceChildren();
    conversationList.replaceChildren();

    userCount.textContent = "0";
}


// =====================================
// EVENT LISTENERS
// =====================================

loginForm.addEventListener("submit", event => {
    event.preventDefault();
    login();
});

registerForm.addEventListener("submit", event => {
    event.preventDefault();
    register();
});

showRegister.addEventListener("click", showRegisterForm);
showLogin.addEventListener("click", showLoginForm);

toggleLoginPassword.addEventListener("click", () => {
    togglePassword(loginPassword, toggleLoginPassword);
});

toggleRegisterPassword.addEventListener("click", () => {
    togglePassword(registerPassword, toggleRegisterPassword);
});

sendButton.addEventListener("click", sendMessage);

messageInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
        sendMessage();
    }
});

leaveButton.addEventListener("click", leaveChat);
logoutButton.addEventListener("click", logout);


// =====================================
// INITIALIZE
// =====================================

setStatus(false, "Offline");
showLoginForm();
