
"use strict";

// =====================================
// PYCHAT - WEBSOCKET CLIENT
// =====================================

// After deploying the Python server,
// replace this URL with your Render URL.
//
// Example:
// wss://pychat-server.onrender.com


const SERVER_URL = "wss://pychat-8gdk.onrender.com";


let socket = null;
let username = "";
let joined = false;

// HTML elements
const loginScreen = document.getElementById("loginScreen");
const chatScreen = document.getElementById("chatScreen");

const usernameInput = document.getElementById("username");
const joinButton = document.getElementById("joinButton");
const loginError = document.getElementById("loginError");

const messages = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendButton = document.getElementById("sendButton");

const userList = document.getElementById("userList");
const userCount = document.getElementById("userCount");

const statusDot = document.getElementById("statusDot");
const connectionStatus = document.getElementById("connectionStatus");

const myUsername = document.getElementById("myUsername");
const myAvatar = document.getElementById("myAvatar");

const leaveButton = document.getElementById("leaveButton");


// =====================================
// CONNECTION STATUS
// =====================================

function setStatus(online, text) {
    statusDot.classList.toggle("online", online);
    connectionStatus.textContent = text;
}


// =====================================
// CONNECT TO SERVER
// =====================================

function connectToServer() {

    return new Promise((resolve, reject) => {

        if (
            SERVER_URL.includes("YOUR-SERVICE") ||
            !SERVER_URL.startsWith("wss://")
        ) {
            reject(
                new Error("Server URL has not been configured.")
            );
            return;
        }

        socket = new WebSocket(SERVER_URL);

        socket.onopen = () => {
            setStatus(true, "Connected");

            socket.send(JSON.stringify({
                type: "JOIN",
                username: username
            }));
        };

        socket.onmessage = (event) => {

            let packet;

            try {
                packet = JSON.parse(event.data);
            } catch {
                return;
            }

            handlePacket(packet, resolve, reject);
        };

        socket.onerror = () => {
            reject(new Error("Unable to connect to server."));
        };

        socket.onclose = () => {

            setStatus(false, "Offline");

            if (joined) {
                joined = false;
                showLogin();
                loginError.textContent =
                    "Connection lost. Please join again.";
            }
        };

    });
}


// =====================================
// HANDLE SERVER PACKETS
// =====================================

function handlePacket(packet, resolve, reject) {

    switch (packet.type) {

        case "WELCOME":

            joined = true;

            myUsername.textContent = username;
            myAvatar.textContent =
                username.charAt(0).toUpperCase();

            loginScreen.classList.add("hidden");
            chatScreen.classList.remove("hidden");

            addNotice(packet.message);

            messageInput.focus();

            resolve(true);
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
                packet.count ?? packet.users.length;

            break;


        case "ERROR":

            if (!joined) {
                reject(new Error(packet.message));
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

async function joinChat() {

    username = usernameInput.value.trim();

    loginError.textContent = "";

    if (!username) {
        loginError.textContent =
            "Please enter your username.";
        return;
    }

    if (username.length > 20) {
        loginError.textContent =
            "Username must be under 20 characters.";
        return;
    }

    joinButton.disabled = true;
    joinButton.textContent = "Connecting...";

    try {

        await connectToServer();

    } catch (error) {

        loginError.textContent = error.message;

        if (socket) {
            socket.close();
            socket = null;
        }

    } finally {

        joinButton.disabled = false;
        joinButton.textContent = "Join Chat";

    }
}


// =====================================
// SEND MESSAGE
// =====================================

function sendMessage() {

    const message = messageInput.value.trim();

    if (!message || !joined) {
        return;
    }

    if (!socket || socket.readyState !== WebSocket.OPEN) {
        addNotice("Connection is not available.");
        return;
    }

    socket.send(JSON.stringify({
        type: "MESSAGE",
        message: message
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

    const isMine = sender === username;

    const message = document.createElement("div");
    message.className = "message" +
        (isMine ? " mine" : "");

    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = sender;

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";

    // textContent prevents HTML injection
    bubble.textContent = text;

    message.appendChild(meta);
    message.appendChild(bubble);

    messages.appendChild(message);

    messages.scrollTop = messages.scrollHeight;
}


// =====================================
// SYSTEM NOTIFICATIONS
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

    users.forEach(name => {

        const li = document.createElement("li");

        const avatar = document.createElement("div");
        avatar.className = "user-avatar";

        avatar.textContent =
            name.charAt(0).toUpperCase();

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
// LEAVE CHAT
// =====================================

function leaveChat() {

    if (socket && socket.readyState === WebSocket.OPEN) {

        socket.send(JSON.stringify({
            type: "LEAVE"
        }));

        socket.close();
    }

    joined = false;
    socket = null;

    showLogin();
}


function showLogin() {

    loginScreen.classList.remove("hidden");
    chatScreen.classList.add("hidden");

    setStatus(false, "Offline");

    messages.replaceChildren();

    const empty = document.createElement("div");
    empty.className = "empty-state";

    const title = document.createElement("h3");
    title.textContent = "Welcome to PyChat!";

    const description = document.createElement("p");
    description.textContent = "Send your first message.";

    empty.appendChild(title);
    empty.appendChild(description);

    messages.appendChild(empty);

    userList.replaceChildren();

    userCount.textContent = "0";

}


// =====================================
// EVENT LISTENERS
// =====================================

joinButton.addEventListener("click", joinChat);

usernameInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
        joinChat();
    }
});

sendButton.addEventListener("click", sendMessage);

messageInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
        sendMessage();
    }
});

leaveButton.addEventListener("click", leaveChat);


// =====================================
// INITIALIZE
// =====================================

setStatus(false, "Offline");

