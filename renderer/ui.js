function showNotification(message, type = "success", duration = 3000) {
    const existing = document.getElementById("saveMessage");
    if (existing) existing.remove();
  
    const msg = document.createElement("div");
    msg.id = "saveMessage";
    msg.textContent = message;
    msg.className = type === "success" ? "notification success" : "notification error";
  
    const button = document.getElementById("saveConfigBtn");
    const container = button.parentElement;
    container.appendChild(msg);
  
    const buttonRect = button.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const leftOffset = buttonRect.left - containerRect.left + buttonRect.width / 2;
  
    msg.style.position = "absolute";
    msg.style.top = "-30px";
    msg.style.left = `${leftOffset}px`;
    msg.style.transform = "translate(-50%, -20px)";
    msg.style.opacity = "0";
  
    msg.getBoundingClientRect();
    msg.style.transition = "opacity 0.5s, transform 0.5s";
    msg.style.opacity = "1";
    msg.style.transform = "translate(-50%, 0)";
  
    setTimeout(() => {
      msg.style.opacity = "0";
      msg.style.transform = "translate(-50%, -20px)";
      setTimeout(() => msg.remove(), 500);
    }, duration);
  }
  
  module.exports = { showNotification };  