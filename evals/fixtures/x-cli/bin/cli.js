#!/usr/bin/env node
// Greets the name given on the command line.
const name = process.argv[2] ?? "world";
console.log(`Hello, ${name}!`);
