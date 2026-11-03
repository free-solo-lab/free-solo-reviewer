/**
 * Verifies update manifests; the matching private key is the REVIEWER_UPDATE_KEY secret. Changing
 * it means apps with the old key stop accepting updates and have to be reinstalled once.
 */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAF8OFWDal6YQ4v2FzCi7OfEximlElDyk6Ifr0DPQl5Ag=
-----END PUBLIC KEY-----
`;
