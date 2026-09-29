// ESM resolve hook: Node's native TS stripping still requires an extension, so
// extensionless relative specifiers (e.g. "../shared/bindings") fail. Try ".ts".
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[^/]+$/.test(specifier)) {
    try {
      return await next(`${specifier}.ts`, context);
    } catch {
      // No .ts file — fall through to the plain specifier.
    }
  }
  return next(specifier, context);
}
