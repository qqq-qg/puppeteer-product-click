
DROP TABLE IF EXISTS `pms_view_task`;

CREATE TABLE `pms_view_task` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT 'ID',
  `platform` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'shopee' COMMENT '平台',
  `link` text CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci COMMENT '链接',
  `title` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '产品标题',
  `shop_name` varchar(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '' COMMENT '店铺名称',
  `step` tinyint NOT NULL DEFAULT '0' COMMENT '进度',
  `status` tinyint NOT NULL DEFAULT '0' COMMENT '状态(1-running)',
  `expect_vn` int NOT NULL DEFAULT '1' COMMENT '期望流量',
  `view_vn` int NOT NULL DEFAULT '0' COMMENT 'view_vn',
  `finished` tinyint NOT NULL DEFAULT '0' COMMENT '是否已完成',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  `updated_at` timestamp NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

/*Data for the table `pms_view_task` */

insert  into `pms_view_task`(`id`,`platform`,`link`,`title`,`shop_name`,`step`,`status`,`expect_vn`,`view_vn`,`finished`,`created_at`,`updated_at`) values (1,'lazada','https://pdp.lazada.co.th/products/i2710784429.html?spm=a1zawg.20038917.content_wrap.9.73bf4edfLFq4b7','','',0,0,5,0,1,'2021-09-06 19:18:43','2021-09-07 14:44:32'),(2,'lazada','https://www.lazada.com.my/products/raya-sale-meiyanqiong-high-quality-smooth-skin-cream-for-stretch-marks-scar-removal-to-maternity-skin-repair-body-cream-remove-scar-care-postpartum-i577292929-s3485538657.html?spm=a2o4k.searchlist.list.3.645218e9STr3kR&search=1','','',0,0,10,0,1,'2021-09-06 19:18:51','2021-09-07 14:44:34'),(3,'shopee','https://my.xiapibuy.com/product/527209096/13605351720/','Instant Whitening Cream Underarm Armpit Legs Knees Private Parts Body Bleaching lotion Serum Female Peeling Beauty','77wv35r6ha',3,0,10,10,0,'2021-09-07 19:15:10','2021-09-08 13:37:49');
