/* commandManager.ts
 This file is responsible for registering commands for the FlutterGPT extension.
 Commands can be registered as VS Code commands, context menu items, or keyboard shortcuts.
 Each command is associated with a handler function that gets executed when the command is invoked.

 To register a new command:
 1. Add a new entry to the `commands` array in the `initCommands` function.
 2. Provide the `name` of the command, the `handler` function, and the `options` object.
 3. The `options` object specifies whether the command is a regular command (`isCommand`),
    appears in the context menu (`isMenu`), or is triggered by a keyboard shortcut (`isShortcut`).
 4. Use the `registerCommand` function to add the command to the VS Code context.
    This function also checks if the API key is valid before executing the handler.

 Example command registration:
 {
     name: 'fluttergpt.doSomething',
     handler: () => doSomethingFunction(),
     options: { isCommand: true, isMenu: true, isShortcut: false }
 }

 Note: The `handler` function can be an async function if needed.
*/
import * as vscode from 'vscode';
import { checkApiKeyAndPrompt } from '../extension';
import { addToReference } from '../tools/reference/add_reference';
import { createWidgetFromDescription } from '../tools/create/widget_from_description';
import { createCodeFromBlueprint } from '../tools/create/code_from_blueprint';
import { createCodeFromDescription } from '../tools/create/code_from_description';
import { refactorCode } from '../tools/refactor/refactor_from_instructions';
import { ILspAnalyzer } from '../shared/types/LspAnalyzer';
import { GeminiRepository } from '../repository/gemini-repository';
import { fixErrors } from '../tools/refactor/fix_errors';
import { optimizeCode } from '../tools/refactor/optimize_code';
import { logEvent } from './telemetry-reporter';
import { FlutterGPTViewProvider } from '../providers/chat_view_provider'; // Adjust the import path accordingly


export function registerCommand(
    context: vscode.ExtensionContext,
    name: string,
    handler: (...args: any[]) => any,
    options: { isCommand: boolean; isMenu: boolean; isShortcut: boolean }
) {
    const { isCommand, isMenu, isShortcut } = options;

    let baseCommand = vscode.commands.registerCommand(name, async (...args: any[]) => {
        const apiKeyValid = await checkApiKeyAndPrompt(context);
        if (apiKeyValid) {
            logEvent(name, { 'type': 'commands', 'isCommand': isCommand.toString(), 'isShortcut': isShortcut.toString(), 'isMenu': isMenu.toString() });
            handler(...args);
        }
    });

    context.subscriptions.push(baseCommand);

    if (isMenu) {
        let menuCommand = vscode.commands.registerCommand(`${name}.menu`, async (...args: any[]) => {
            const apiKeyValid = await checkApiKeyAndPrompt(context);
            if (apiKeyValid) {
                logEvent(name, { 'type': 'commands', 'isCommand': isCommand.toString(), 'isShortcut': isShortcut.toString(), 'isMenu': isMenu.toString() });
                handler(...args);
            }
        });
        context.subscriptions.push(menuCommand);
    }
}

let isChatOpen = false;
export function initCommands(context: vscode.ExtensionContext, geminiRepo: any, analyzer: any, flutterGPTViewProvider: FlutterGPTViewProvider) {

    // List of commands to register, with their names and options.
    const commands = [
        {
            name: 'fluttergpt.toggleChat',
            handler: async () => {
                if (isChatOpen) {
                    vscode.commands.executeCommand('workbench.action.closeSidebar');
                } else {
                    vscode.commands.executeCommand('workbench.view.extension.webview');
                }
                isChatOpen = !isChatOpen;
            },
            options: { isCommand: false, isMenu: false, isShortcut: true }
        },
        { name: 'fluttergpt.addToReference', handler: () => addToReference(context.globalState), options: { isCommand: true, isMenu: true, isShortcut: false } },
        { name: 'fluttergpt.createWidget', handler: async () => createWidgetFromDescription(geminiRepo, context.globalState), options: { isCommand: true, isMenu: true, isShortcut: false } },
        { name: 'fluttergpt.createCodeFromBlueprint', handler: () => createCodeFromBlueprint(geminiRepo, context.globalState), options: { isCommand: true, isMenu: true, isShortcut: false } },
        { name: 'fluttergpt.createCodeFromDescription', handler: () => createCodeFromDescription(geminiRepo, context.globalState), options: { isCommand: true, isMenu: true, isShortcut: false } },
        { name: 'fluttergpt.refactorCode', handler: (aiRepo: GeminiRepository, globalState: vscode.Memento, range: vscode.Range, anlyzer: ILspAnalyzer, elementName: string | undefined) => refactorCode(geminiRepo, context.globalState, range, analyzer, elementName), options: { isCommand: true, isMenu: false, isShortcut: false } },
        { name: 'fluttergpt.fixErrors', handler: (aiRepo: GeminiRepository, errors: vscode.Diagnostic[], globalState: vscode.Memento, range: vscode.Range, anlyzer: ILspAnalyzer, elementName: string | undefined) => fixErrors(geminiRepo, errors, context.globalState, range, analyzer, elementName), options: { isCommand: true, isMenu: false, isShortcut: false } },
        { name: 'fluttergpt.optimizeCode', handler: (aiRepo: GeminiRepository, globalState: vscode.Memento, range: vscode.Range, anlyzer: ILspAnalyzer, elementName: string | undefined) => optimizeCode(geminiRepo, context.globalState, range, anlyzer, elementName), options: { isCommand: true, isMenu: false, isShortcut: false } },
        // Add more commands as needed.
    ];

    // Register all commands.
    commands.forEach(cmd => registerCommand(context, cmd.name, cmd.handler, cmd.options));
}