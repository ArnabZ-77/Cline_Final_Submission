// profile.js          BUG 02 null/undefined access
export function getUserCity(user) {
  return user.address.city;
}
