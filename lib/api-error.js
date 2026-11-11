export class ApiError extends Error {
  constructor(status, code, message = code) { super(message); Object.assign(this, { status, code }); }
}
export const fail = (status, code, message) => { throw new ApiError(status, code, message); };
