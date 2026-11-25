// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PayeeRegistry — Confirmation of Payee for Aevum Testnet
/// @notice Binds a payee name hash to the address that owns it, so a payer (or a
///         checking agent) can verify that the name on an invoice and the address
///         being paid actually belong together before money moves.
/// @dev A name hash is keccak256 of the normalized payee name (lowercase, trimmed),
///      computed off-chain. Only the owner of an address can bind or revoke its name.
contract PayeeRegistry {
    mapping(bytes32 => address) public nameToAddress;
    mapping(address => bytes32) public addressToName;

    event PayeeRegistered(address indexed account, bytes32 indexed nameHash);
    event PayeeRevoked(address indexed account, bytes32 indexed nameHash);

    /// @notice Bind msg.sender to a payee name hash. Re-binding moves the caller's
    ///         previous name to the new one. A name already bound to a different
    ///         address cannot be taken over.
    function register(bytes32 nameHash) external {
        require(nameHash != bytes32(0), "empty name");
        address current = nameToAddress[nameHash];
        require(current == address(0) || current == msg.sender, "name bound to another address");

        bytes32 previous = addressToName[msg.sender];
        if (previous != bytes32(0) && previous != nameHash) {
            delete nameToAddress[previous];
        }
        nameToAddress[nameHash] = msg.sender;
        addressToName[msg.sender] = nameHash;
        emit PayeeRegistered(msg.sender, nameHash);
    }

    /// @notice Remove the caller's name binding entirely (instant revocation).
    function revoke() external {
        bytes32 previous = addressToName[msg.sender];
        require(previous != bytes32(0), "nothing to revoke");
        delete nameToAddress[previous];
        delete addressToName[msg.sender];
        emit PayeeRevoked(msg.sender, previous);
    }

    /// @notice Confirmation-of-Payee check: does this exact name belong to this
    ///         exact address?
    function matches(bytes32 nameHash, address account) external view returns (bool) {
        return account != address(0) && nameToAddress[nameHash] == account;
    }
}
