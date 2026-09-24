// src/gateway.js
// Picks the payment gateway: Razorpay if its keys are set on Render, otherwise the demo gateway.
const razorpay = require('./razorpay');
module.exports = razorpay.configured ? razorpay : require('./demoGateway');
