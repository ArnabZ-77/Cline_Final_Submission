// update.js           BUG 08 missing validation
import { getUser } from "./signup.js";

export function updateEmail(id, newEmail) {
  const user = getUser(id);
  user.email = String(newEmail);
  return user;
}
