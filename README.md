# algo-bootstrap-functions

Algo Bootstrap 相关云函数。

目前绑定服务商为腾讯云。

## 初始化新的云函数

1. 进入 `packages` 目录
2. `npx scf init scf-nodejs --name <function-name>` 初始化云函数，函数名需要以  `algoux-ab-` 开头
3. 进入创建的目录，修改 `serverless.yml` 配置中的必要字段，如：
   - `region: ap-shanghai`
   - `runtime: Nodejs16.13`
4. 如需安装其他依赖，则通过 `npm init -y` 初始化 `package.json`，修改包名以 `algo-bootstrap-f-` 开头
5. 修改默认生成的 `serverless.yml` 为 `serverless.template.yml` 并根据需要修改配置，注意涉及敏感字段内容需要置空

## 本地部署

警告：需要知晓对应云函数部署到线上的相关运维参数，否则无法部署，强制本地部署将损坏线上环境变量等配置。

1. 进入 `packages` 目录下的相关要部署的云函数目录
2. 复制 `serverless.template.yml` 为 `serverless.yml`，并配置里面需要修改的配置段，如 `environment`
3. 使用 `scf deploy` 命令部署云函数
