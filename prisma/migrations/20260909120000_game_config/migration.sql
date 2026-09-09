-- CreateTable
CREATE TABLE `Game` (
    `key` ENUM('SLOT', 'DICE', 'FISH') NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `subtitle` VARCHAR(120) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `minBet` BIGINT NOT NULL,
    `maxBet` BIGINT NOT NULL,
    `maintenanceNote` VARCHAR(200) NULL,
    `config` JSON NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` VARCHAR(191) NULL,

    INDEX `Game_enabled_sortOrder_idx`(`enabled`, `sortOrder`),
    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
