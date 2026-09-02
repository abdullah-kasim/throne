import { Command as CommanderCommand } from 'commander';
import { Command, CommandRunner } from 'nest-commander';
import {
  NOTIFY_CONFIG,
  postNtfyMessage,
  type NotifyConfig,
  type PostNtfyMessageOptions,
} from './notification.service.ts';
import {
  ApplicationConfigService,
  PERSONA_CONFIG,
} from '../application-config.service.ts';
import { NotificationService } from './notification.service.ts';
import { errorText } from '../shared-policy/error-text.ts';
import { renderEntranceRefusal } from '../shared-policy/entrance-refusal.ts';

export const LORD_NOTIFICATION_TITLE = `Message from the ${PERSONA_CONFIG.throneTitle.toLowerCase()}`;

export interface NotifyLordDependencies {
  postMessage: (
    message: string,
    config: Pick<NotifyConfig, 'serverUrl' | 'topic' | 'timeoutMs'>,
    options: PostNtfyMessageOptions,
  ) => Promise<void>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
  addressTitle?: string;
}

const PRODUCTION_DEPENDENCIES: NotifyLordDependencies = {
  postMessage: postNtfyMessage,
  writeStdout: (text) => process.stdout.write(text),
  writeStderr: (text) => process.stderr.write(text),
};

export async function runNotifyLord(
  args: string[],
  dependencies: NotifyLordDependencies = PRODUCTION_DEPENDENCIES,
): Promise<number> {
  const message = args.join(' ').trim();
  if (message === '') {
    dependencies.writeStderr(
      'notify-lord: message required. Usage: ./bin/throne-cli notify-lord <message...>\n',
    );
    dependencies.writeStderr(
      `${renderEntranceRefusal({
        reason: 'notify-lord entrance validation requires a non-empty message.',
        bypass: undefined,
        supervisorRoute: 'Ask your supervisor for an allowed alternative invocation.',
      })}\n`,
    );
    return 1;
  }

  try {
    await dependencies.postMessage(message, NOTIFY_CONFIG, {
      title: LORD_NOTIFICATION_TITLE,
    });
  } catch (error) {
    dependencies.writeStderr(
      `notify-lord: failed to notify the ${dependencies.addressTitle ?? 'Lord'} (${errorText(error)})\n`,
    );
    return 1;
  }

  dependencies.writeStdout(
    `notify-lord: message delivered to the ${dependencies.addressTitle ?? 'Lord'}.\n`,
  );
  return 0;
}

@Command({
  name: 'notify-lord',
  allowUnknownOptions: true,
  allowExcessArgs: true,
})
export class NotifyLordCommand extends CommandRunner {
  private readonly dependencies: NotifyLordDependencies;
  private readonly notifications: NotificationService;
  private readonly applicationConfig: ApplicationConfigService;

  constructor(
    dependencies?: NotifyLordDependencies,
    notifications: NotificationService = new NotificationService(),
    applicationConfig: ApplicationConfigService = new ApplicationConfigService(),
  ) {
    super();
    this.notifications = notifications;
    this.applicationConfig = applicationConfig;
    this.dependencies = dependencies ?? {
      postMessage: (message, _config, options) => this.notifications.send(message, options),
      writeStdout: (text) => process.stdout.write(text),
      writeStderr: (text) => process.stderr.write(text),
      addressTitle: this.applicationConfig.personaConfig.addressTitle,
    };
  }

  override setCommand(command: CommanderCommand): this {
    super.setCommand(command);
    command.helpOption(false);
    return this;
  }

  async run(passedParams: string[]): Promise<void> {
    process.exitCode = await runNotifyLord(passedParams, this.dependencies);
  }
}
