// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title Categories
/// @notice Use categories and regions as bitmasks. The banned set is a constant: no role, signature
///         or upgrade can licence a likeness for political, adult, minor-involving, impersonating or
///         deceptive use. Every contract that accepts a category routes it through `requireLicensable`.
library Categories {
    // Banned, permanently. Bits 0-7 are reserved for banned uses.
    uint32 internal constant POLITICAL = 1 << 0;
    uint32 internal constant ADULT = 1 << 1;
    uint32 internal constant MINORS = 1 << 2;
    uint32 internal constant IMPERSONATION = 1 << 3;
    uint32 internal constant DECEPTION = 1 << 4;
    uint32 internal constant BANNED = POLITICAL | ADULT | MINORS | IMPERSONATION | DECEPTION | 0xE0;

    // Licensable uses. Bits 8 and up.
    uint32 internal constant ADVERTISING = 1 << 8;
    uint32 internal constant SOCIAL = 1 << 9;
    uint32 internal constant EDITORIAL = 1 << 10;
    uint32 internal constant ENTERTAINMENT = 1 << 11;
    uint32 internal constant PRODUCT = 1 << 12;
    uint32 internal constant ALLOWED = ADVERTISING | SOCIAL | EDITORIAL | ENTERTAINMENT | PRODUCT;

    error BannedCategory(uint32 categories);
    error UnknownCategory(uint32 categories);
    error NotSingleCategory(uint32 category);
    error EmptyRegions();

    /// @notice A creator's allowed set: non-empty, no banned bit, no unknown bit.
    function requireAllowedSet(uint32 categories) internal pure {
        if (categories & BANNED != 0) revert BannedCategory(categories);
        if (categories == 0 || categories & ~ALLOWED != 0) revert UnknownCategory(categories);
    }

    /// @notice A licence's category: exactly one allowed bit.
    function requireLicensable(uint32 category) internal pure {
        requireAllowedSet(category);
        if (category & (category - 1) != 0) revert NotSingleCategory(category);
    }

    function requireRegions(uint32 regions) internal pure {
        if (regions == 0) revert EmptyRegions();
    }
}
