// Handles the sign-up form.
export function submit(data) {
  return { ok: true, saved: { email: data.email, age: data.age } };
}
