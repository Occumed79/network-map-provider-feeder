const ts = () => new Date().toISOString();

export const logger = {
  info: (msg, meta) =>
    console.log(JSON.stringify({ level: "info", ts: ts(), msg, ...meta })),
  warn: (msg, meta) =>
    console.warn(JSON.stringify({ level: "warn", ts: ts(), msg, ...meta })),
  error: (msg, meta) =>
    console.error(JSON.stringify({ level: "error", ts: ts(), msg, ...meta })),
  debug: (msg, meta) => {
    if (process.env.LOG_LEVEL === "debug")
      console.log(JSON.stringify({ level: "debug", ts: ts(), msg, ...meta }));
  },
};
