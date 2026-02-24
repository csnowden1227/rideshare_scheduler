import fs from "fs";

const s = fs.readFileSync("./server.js", "utf8");

// Quick checks for common “Unexpected end of input” causes
const openBlockComments = (s.match(/\/\*/g) || []).length;
const closeBlockComments = (s.match(/\*\//g) || []).length;

console.log("Block comments: /* =", openBlockComments, " */ =", closeBlockComments);

if (openBlockComments !== closeBlockComments) {
  console.log("❌ You have an unclosed block comment /* ... */ somewhere.");
}

// Count backticks (template literals). This is a rough check.
const backticks = (s.match(/`/g) || []).length;
console.log("Backticks (`) count:", backticks);
if (backticks % 2 !== 0) {
  console.log("❌ You have an unclosed template string using backticks (`... ) somewhere.");
}

// Now do a simple brace/paren/bracket balance check ignoring strings/comments
let stack = [];
let state = "code"; // code | sQuote | dQuote | template | lineComment | blockComment
for (let i = 0; i < s.length; i++) {
  const c = s[i];
  const n = s[i + 1];

  // Handle state transitions
  if (state === "code") {
    if (c === "/" && n === "/") { state = "lineComment"; i++; continue; }
    if (c === "/" && n === "*") { state = "blockComment"; i++; continue; }
    if (c === "'") { state = "sQuote"; continue; }
    if (c === '"') { state = "dQuote"; continue; }
    if (c === "`") { state = "template"; continue; }

    if (c === "{" || c === "(" || c === "[") stack.push({ ch: c, i });
    if (c === "}" || c === ")" || c === "]") {
      const top = stack.pop();
      const want = c === "}" ? "{" : c === ")" ? "(" : "[";
      if (!top || top.ch !== want) {
        console.log("❌ Mismatched closer", c, "at index", i, "near:", JSON.stringify(s.slice(Math.max(0,i-30), i+30)));
        process.exit(1);
      }
    }
  } else if (state === "lineComment") {
    if (c === "\n") state = "code";
  } else if (state === "blockComment") {
    if (c === "*" && n === "/") { state = "code"; i++; }
  } else if (state === "sQuote") {
    if (c === "\\" && n) { i++; continue; }
    if (c === "'") state = "code";
  } else if (state === "dQuote") {
    if (c === "\\" && n) { i++; continue; }
    if (c === '"') state = "code";
  } else if (state === "template") {
    if (c === "\\" && n) { i++; continue; }
    if (c === "`") state = "code";
  }
}

if (state !== "code") {
  console.log("❌ File ends while still inside:", state, "(unterminated string/comment).");
}

if (stack.length) {
  const last = stack[stack.length - 1];
  console.log("❌ Unclosed bracket/brace/paren:", last.ch, "opened at index", last.i);
  console.log("Near:", JSON.stringify(s.slice(Math.max(0,last.i-30), last.i+60)));
} else if (state === "code" && openBlockComments === closeBlockComments && backticks % 2 === 0) {
  console.log("✅ No obvious unclosed braces/comments/strings found (might be a different syntax issue).");
}
