// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20Metadata {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice Minimal SafeERC20 (vendored): accepts tokens that return true or nothing, reverts otherwise.
library SafeERC20 {
    function safeTransfer(IERC20Metadata token, address to, uint256 amount) internal {
        _call(token, abi.encodeCall(IERC20Metadata.transfer, (to, amount)));
    }

    function safeTransferFrom(IERC20Metadata token, address from, address to, uint256 amount) internal {
        _call(token, abi.encodeCall(IERC20Metadata.transferFrom, (from, to, amount)));
    }

    function _call(IERC20Metadata token, bytes memory data) private {
        require(address(token).code.length > 0, "SafeERC20: not a contract");
        (bool ok, bytes memory ret) = address(token).call(data);
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "SafeERC20: transfer failed");
    }
}
