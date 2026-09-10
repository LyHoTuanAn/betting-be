-- Thêm ROULETTE vào GameType. Chỉ nới rộng danh sách enum nên dữ liệu ván chơi
-- và cấu hình game hiện có không bị ảnh hưởng.
ALTER TABLE `Game` MODIFY COLUMN `key` ENUM('SLOT', 'DICE', 'FISH', 'ROULETTE') NOT NULL;
ALTER TABLE `GameRound` MODIFY COLUMN `game` ENUM('SLOT', 'DICE', 'FISH', 'ROULETTE') NOT NULL;
