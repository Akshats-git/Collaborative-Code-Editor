export interface User {
    name: string;
    color: string;
}
/**
 * There is no account system yet, so an identity is generated per tab and kept
 * in sessionStorage. Two tabs are two users, which is exactly what you want when
 * testing collaboration on one machine.
 */
export declare function localUser(): User;
//# sourceMappingURL=user.d.ts.map