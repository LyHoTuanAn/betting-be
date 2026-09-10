-- Số dư bị giữ cho các yêu cầu rút đang chờ duyệt. Tiêu được = balance - lockedBalance.
ALTER TABLE `User` ADD COLUMN `lockedBalance` BIGINT NOT NULL DEFAULT 0;

-- Tài khoản nhận tiền người chơi khai khi rút. NULL cho các yêu cầu tạo trước đây.
ALTER TABLE `WalletRequest`
  ADD COLUMN `bankName` VARCHAR(80) NULL,
  ADD COLUMN `accountNumber` VARCHAR(32) NULL,
  ADD COLUMN `accountName` VARCHAR(80) NULL;

-- Tài khoản Timo của hệ thống hiển thị ở trang nạp tiền.
CREATE TABLE `BankAccount` (
  `id` VARCHAR(191) NOT NULL,
  `bankName` VARCHAR(80) NOT NULL,
  `accountNumber` VARCHAR(32) NOT NULL,
  `accountName` VARCHAR(80) NOT NULL,
  `transferContentDescription` VARCHAR(200) NOT NULL,
  `isActive` BOOLEAN NOT NULL DEFAULT true,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  INDEX `BankAccount_isActive_idx`(`isActive`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Giao dịch tiền vào đọc từ email ngân hàng.
-- UNIQUE(bankTransactionId) là chốt chặn chống cộng tiền hai lần.
CREATE TABLE `BankDeposit` (
  `id` VARCHAR(191) NOT NULL,
  `bankTransactionId` VARCHAR(80) NOT NULL,
  `amount` BIGINT NOT NULL,
  `transferContent` VARCHAR(255) NOT NULL,
  `transactionTime` DATETIME(3) NOT NULL,
  `status` ENUM('COMPLETED', 'UNMATCHED') NOT NULL,
  `userId` VARCHAR(191) NULL,
  `matchedAt` DATETIME(3) NULL,
  `resolvedById` VARCHAR(191) NULL,
  `resolvedAt` DATETIME(3) NULL,
  `emailSubject` VARCHAR(255) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `BankDeposit_bankTransactionId_key`(`bankTransactionId`),
  INDEX `BankDeposit_status_createdAt_idx`(`status`, `createdAt` DESC),
  INDEX `BankDeposit_userId_createdAt_idx`(`userId`, `createdAt` DESC),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `BankDeposit` ADD CONSTRAINT `BankDeposit_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `BankDeposit` ADD CONSTRAINT `BankDeposit_resolvedById_fkey` FOREIGN KEY (`resolvedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Chuyển các yêu cầu rút PENDING cũ sang cách tính mới.
-- Luồng cũ trừ thẳng vào `balance` khi tạo yêu cầu; luồng mới giữ tiền trong
-- `balance` và chỉ khoá bằng `lockedBalance`. Trả lại phần đã trừ rồi khoá lại,
-- nếu không số dư khả dụng vẫn đúng nhưng tổng số dư hiển thị bị thiếu.
UPDATE `User` `u`
JOIN (
  SELECT `userId`, SUM(`amount`) AS `held`
  FROM `WalletRequest`
  WHERE `status` = 'PENDING' AND `type` = 'WITHDRAW'
  GROUP BY `userId`
) `w` ON `w`.`userId` = `u`.`id`
SET `u`.`balance` = `u`.`balance` + `w`.`held`,
    `u`.`lockedBalance` = `u`.`lockedBalance` + `w`.`held`;
