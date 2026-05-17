# Обновление плагина publish-telegram

Изменения касающиеся токена телеграм бота:

Токен телеграм бота нужно хранить в хранилище ключей Obsidian. Хранилище доступно начиная с версии Obsidian 1.11.4
Если версия Obsidian ниже, то использовать для хранения токена data.json (также как сейчас, предупредить пользователя обновить Obsidian для конфиденциального хранения токена в хранилище ключей).
Если версия Obsidian с поддержкой хранилища ключей, то использовать его, а из data.json удалить токен телеграм бота и оповестить об этом пользователя.

Изменения касающиеся выборочной отправки:

Отправляться в телеграм должна не вся заметка, а только часть, ограниченная маркерами начала текстового блока и конца текстового блока.
Такие маркеры пользователь задаёт самостоятельно в настройках плагина.
В настройки плагина нужно добавить поля для маркеров начала текстового блока и конца текстового блока.
По умолчанию для маркера начала текстового блока использовать :::post-start-here
По умолчанию для маркера конца текстового блока использовать :::post-end-here

Дополнительная информация для разработки:

В телеграм есть ограничения по постингу в каналы от ботов. Эти ограничения нужно дописать в help для пользователя. А также предупреждать пользователя до отправки, если превышены лимиты, давать сводку.


SecretStorage — хранилище ключей в Obsidian. Минимальная версия Obsidian 1.11.4

SecretStorage обеспечивает безопасный способ хранения конфиденциальных данных, таких как ключи API и токены, и управления ими в плагинах Obsidian. Вместо того чтобы хранить секретные данные непосредственно в файле data.json вашего плагина, SecretStorage предлагает централизованное хранилище «ключ-значение», которое позволяет пользователям обмениваться секретными данными между несколькими плагинами.  
В этом руководстве вы узнаете, как использовать SecretStorage и SecretComponent для безопасного хранения секретных данных в настройках вашего плагина.

После прочтения этого руководства вы сможете: Заменить прямой ввод секретных данных на SecretComponent. Получать сохраненные секретные данные с помощью API SecretStorage. Понять, почему SecretStorage повышает уровень безопасности и удобство использования.

Когда плагины хранят секретные данные непосредственно в файле data.json, возникает несколько проблем:  
  
Безопасность: секретные данные хранятся в открытом виде вместе с другими данными плагина.  
Дублирование: пользователям приходится копировать один и тот же ключ API в каждый плагин, которому он нужен.  
Обслуживание: при смене токена пользователям приходится обновлять каждый плагин вручную.  
SecretStorage решает эти проблемы, предоставляя централизованное хранилище для секретных данных. Пользователи сохраняют каждый секрет под определенным именем, и любой плагин может обращаться к нему по этому имени.

## Step 1: Update your settings interface 

Start with a typical plugin settings setup. The `mySetting` property will store the _name_ of a secret, not the secret value itself.

```ts
import { App, PluginSettingTab, Setting } from "obsidian";
import MyPlugin from "./main";

export interface MyPluginSettings {
  mySetting: string;
}
```

## Step 2: Add the SecretComponent to your settings tab 

Replace the standard text input with a `SecretComponent`. Import `SecretComponent` from `obsidian` and use the `addComponent` method on your `Setting`:

```ts
import { App, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import MyPlugin from "./main";

export class SampleSettingTab extends PluginSettingTab {
  plugin: MyPlugin;

  constructor(app: App, plugin: MyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName('API key')
      .setDesc('Select a secret from SecretStorage')
      .addComponent(el => new SecretComponent(this.app, el)
        .setValue(this.plugin.settings.mySetting)
        .onChange(value => {
          this.plugin.settings.mySetting = value;
          this.plugin.saveSettings();
        }));
  }
}
```

The `SecretComponent` presents users with an interface to select from existing secrets or create a new one. When saved, your plugin settings contain the _name_ of the secret, not the actual secret value.

![settings-secretcomponent.png](https://publish-01.obsidian.md/access/caa27d6312fe5c26ebc657cc609543be/Assets/settings-secretcomponent.png)

## Step 3: Retrieve the secret value 

When your plugin needs the actual secret value, use the `SecretStorage` API:

```ts
const secret = app.secretStorage.get(this.settings.mySetting);
if (secret) { // secret value might be null

}
```

This retrieves the secret value associated with the name stored in your settings. The actual secret is stored in local storage, keyed to the specific vault.

## Complete example 

Here's the full settings tab implementation:

```ts
import { App, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import MyPlugin from "./main";

export interface MyPluginSettings {
  mySetting: string;
}

export class SampleSettingTab extends PluginSettingTab {
  plugin: MyPlugin;

  constructor(app: App, plugin: MyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName('API key')
      .setDesc('Select a secret from SecretStorage')
      .addComponent(el => new SecretComponent(this.app, el)
        .setValue(this.plugin.settings.mySetting)
        .onChange(value => {
          this.plugin.settings.mySetting = value;
          this.plugin.saveSettings();
        }));
  }
}
```

## FAQ 

### Why does SecretComponent use `addComponent` instead of having its own method like `addText`? 

Unlike other setting components, `SecretComponent` requires the `App` instance in its constructor to access the SecretStorage API. The standard `addText`, `addToggle`, and similar methods don't pass `App` to their callbacks. The `Setting#addComponent` method gives you full control over component instantiation, allowing you to pass the required `App` reference.

Методы:

getSecret(id) — Gets a secret from storage
listSecrets() — Lists all secrets in storage
setSecret(id, secret) — Sets a secret in the storage

## SecretStorage.getSecret() method 

Gets a secret from storage

**Signature:**

```typescript
getSecret(id: string): string | null;
```

## Parameters 

|Parameter|Type|Description|
|---|---|---|
|`id`|`string`|The secret ID|

**Returns:**

`string | null`

The secret value or null if not found

## SecretStorage.listSecrets() method 

Lists all secrets in storage

**Signature:**

```typescript
listSecrets(): string[];
```

**Returns:**

`string[]`

Array of secret IDs

## SecretStorage.setSecret() method 

Sets a secret in the storage.

**Signature:**

```typescript
setSecret(id: string, secret: string): void;
```

## Parameters 

|Parameter|Type|Description|
|---|---|---|
|`id`|`string`|Lowercase alphanumeric ID with optional dashes|
|`secret`|`string`|The secret value to store|

**Returns:**

`void`

## Exceptions 

Error if ID is invalid