# ****群精华插件****
我也不知道是怎么码出来的，但是能跑起来就不管了。

本插件适用于 [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) 。

目前只在 Napcat + TRSS-Yunzai 测试正常。其它的Yunzai没有测试，不知道能不能用。

# ****插件功能****


```
【群精华消息插件 帮助】
------------------------
1. #设精 或 #设置精华消息（需引用消息）
   - 将引用的消息设为精华
2. #查询精华消息 <ID>
   - 查询指定ID的精华消息
3. #精华消息列表 或 #精华消息列表<页码>
   - 分页查看本群精华消息
4. #随机精华 / #随机群友怪话 / #随机精华消息
   - 随机展示一条本群精华消息
5. #删除精华消息 <ID>（仅Bot主人）
   - 删除指定ID的精华消息
6. #精华消息功能帮助
   - 查看本帮助
------------------------
```


# ****配置****

****插件****
```
// === 配置 ===
const cfg = {
  database: {
    type: 'mysql',  // mysql 或 sqlite
    mysql: {
      host: '1Panel-mysql-Wwag', //你的Mysql地址
      port: 3306, //端口
      user: 'user', //用户名
      password: process.env.DB_PASSWORD || 'Password', //密码
      database: 'msg-qq' //库名
    },
    sqlite: {
      path: path.join(process.cwd(), './data/essence.db') //sqlite数据库的存放目录
    }
  },
  pagination: {pageSize: 5 }, //配置 #精华消息列表 的单页展示的精华消息条数

  tempDir: path.join(process.cwd(), './data/essence_temp'), // 临时文件目录
  imageSaveDir: path.join(process.cwd(), './data/essence_images'), // 本地图片存储目录
};
```

****Mysql****

我不知道数据库初始代码为何跑不起来，那就手动写入吧（

```
DROP TABLE IF EXISTS `essence_messages`;
CREATE TABLE `essence_messages` (
  `message_id` int NOT NULL AUTO_INCREMENT,
  `group_id` bigint NOT NULL,
  `sender_id` bigint NOT NULL,
  `operator_id` bigint NOT NULL,
  `operator_time` datetime NOT NULL,
  `content` text NOT NULL,
  `del_tag` TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`message_id`)
) ENGINE=InnoDB AUTO_INCREMENT=1038 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

****SQLite****

没测试，不清楚。

但是好像并没有完全适配，所以是残疾版。

建议去用Mysql

****咕咕咕****
