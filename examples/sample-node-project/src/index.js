export function greet(name) {
  return `Hello, ${name}!`;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  console.log(greet("local agent laboratory"));
}
