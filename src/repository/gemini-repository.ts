import { ContentEmbedding, GoogleGenerativeAI, TaskType } from "@google/generative-ai";
import * as fs from 'fs';
import * as vscode from "vscode";
import * as crypto from 'crypto';
import path = require("path");

function handleError(error: Error, userFriendlyMessage: string): never {
    console.error(error);
    throw new Error(userFriendlyMessage);
}

export class GeminiRepository {
    private apiKey?: string;
    private genAI: GoogleGenerativeAI;
    private _view?: vscode.Webview;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
        this.genAI = new GoogleGenerativeAI(this.apiKey);
        this.ensureCacheDirExists().catch(error => {
            handleError(error, 'Failed to initialize the cache directory.');
        });
    }

    public async generateTextFromImage(prompt: string, image: string, mimeType: string): Promise<string> {
        const model = this.genAI.getGenerativeModel({ model: "gemini-pro-vision" });
        const imageParts = [
            this.fileToGenerativePart(image, mimeType),
        ];

        const result = await model.generateContent([prompt, ...imageParts]);
        const response = result.response;
        const text = response.text();
        return text;
    }

    public async getCompletion(prompt: { role: string, parts: string }[], isReferenceAdded?: boolean, view?: vscode.WebviewView): Promise<string> {
        if (!this.apiKey) {
            throw new Error('API token not set, please go to extension settings to set it (read README.md for more info)');
        }
        let lastMessage = prompt.pop();

        // Count the tokens in the prompt
        const model = this.genAI.getGenerativeModel({ model: "gemini-pro" });
        const { totalTokens } = await model.countTokens(lastMessage?.parts ?? "");
        console.log("Total input tokens: " + totalTokens);

        // Check if the token count exceeds the limit
        if (totalTokens > 30720) {
            throw Error('Input prompt exceeds the maximum token limit.');
        }

        const chat = this.genAI.getGenerativeModel({ model: "gemini-pro", generationConfig: { temperature: 0.0, topP: 0.2 } }).startChat(
            {
                history: prompt, generationConfig: {
                    maxOutputTokens: 2048,
                },
            }
        );
        const result = await chat.sendMessage(lastMessage?.parts ?? "");

        const response = result.response;
        const text = response.text();
        return text;
    }

    // Cache structure
    private codehashCache: { [filePath: string]: { codehash: string, embedding: ContentEmbedding } } = {};

    public displayWebViewMessage(view?: vscode.WebviewView, type?: string, value?: any) {
        view?.webview.postMessage({
            type,
            value
        });
    }

    private async sleep(msec: number) {
        return new Promise(resolve => setTimeout(resolve, msec));
    }


    // Modify the get cacheFilePath getter to point to a more secure location
    private get cacheFilePath() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            throw new Error('No workspace folders found.');
        }
        const projectFolder = workspaceFolders[0].uri.fsPath; // Assuming single root workspace
        const hash = this.computeCodehash(projectFolder); // Hash the path for uniqueness
        // Use os.tmpdir() to get the system's temporary directory
        const tempDir = require('os').tmpdir();
        return require('path').join(tempDir, 'flutterGPT', `${hash}.codehashCache.json`);
    }


    // Modify the saveCache method to set file permissions after writing the cache file
    private async saveCache() {
        try {
            const cacheData = JSON.stringify(this.codehashCache);
            const cachePath = this.cacheFilePath;
            await fs.promises.writeFile(cachePath, cacheData, { encoding: 'utf8', mode: 0o600 }); // Sets the file mode to read/write for the owner only
        } catch (error) {
            if (error instanceof Error) {
                handleError(error, 'Failed to save the cache data.');
            } else {
                console.error('An unexpected error type was thrown:', error);
            }
        }
    }

    private async loadCache() {
        try {
            if (fs.existsSync(this.cacheFilePath)) {
                const cacheData = await fs.promises.readFile(this.cacheFilePath, 'utf8');
                this.codehashCache = JSON.parse(cacheData);
            }
        } catch (error) {
            console.error("Error loading cache: ", error);
        }
    }

    // Ensure the directory exists and has the correct permissions
    private async ensureCacheDirExists() {
        const cacheDir = path.dirname(this.cacheFilePath);
        try {
            await fs.promises.mkdir(cacheDir, { recursive: true, mode: 0o700 }); // Sets the directory mode to read/write/execute for the owner only
        } catch (error: any) {
            if (error.code !== 'EEXIST') {
                handleError(error as Error, 'Failed to create a secure cache directory.');
            }
        }
    }

    // Compute a codehash for file contents
    private computeCodehash(fileContents: string): string {
        // Normalize the file content by removing whitespace and newlines
        const normalizedContent = fileContents.replace(/\s+/g, '');
        return crypto.createHash('sha256').update(normalizedContent).digest('hex');
    }

    // Find 5 closest dart files for query
    public async findClosestDartFiles(query: string, view?: vscode.WebviewView): Promise<string> {
        //start timer
        let operationCompleted = false;
        const timeoutPromise = new Promise<void>((resolve) => {
            setTimeout(() => {
                if (!operationCompleted) {
                    this.displayWebViewMessage(view, 'stepLoader', { fetchingFileLoader: true });
                }
                resolve();
            }, 5000);
        });
        try {
            if (!this.apiKey) {
                throw new Error('API token not set, please go to extension settings to set it (read README.md for more info)');
            }

            // Load cache if not already loaded
            if (Object.keys(this.codehashCache).length === 0) {
                await this.loadCache();
            }

            // Initialize the embedding model for document retrieval
            const embeddingModel = this.genAI.getGenerativeModel({ model: "embedding-001" });

            // Find all Dart files in the workspace
            const dartFiles = await vscode.workspace.findFiles('**/*.dart');

            // Read the content of each Dart file and compute codehash
            const fileContents = await Promise.all(dartFiles.map(async (file) => {
                const document = await vscode.workspace.openTextDocument(file);
                const relativePath = vscode.workspace.asRelativePath(file, false);
                const text = `File name: ${file.path.split('/').pop()}\nFile path: ${relativePath}\nFile code:\n\n\`\`\`dart\n${document.getText()}\`\`\`\n\n------\n\n`;
                const codehash = this.computeCodehash(text);
                return {
                    text,
                    path: file.path,
                    codehash
                };
            }));

            // Filter out files that haven't changed since last cache
            const filesToUpdate = fileContents.filter(fileContent => {
                const cachedEntry = this.codehashCache[fileContent.path];
                return !cachedEntry || cachedEntry.codehash !== fileContent.codehash;
            });

            // Split the filesToUpdate into chunks of 100 or fewer
            const batchSize = 100;
            const batches = [];
            for (let i = 0; i < filesToUpdate.length; i += batchSize) {
                batches.push(filesToUpdate.slice(i, i + batchSize));
            }

            // Process each chunk to get embeddings
            for (const batch of batches) {
                try {
                    const batchEmbeddings = await embeddingModel.batchEmbedContents({
                        requests: batch.map((fileContent) => ({
                            content: { role: "document", parts: [{ text: fileContent.text }] },
                            taskType: TaskType.RETRIEVAL_DOCUMENT,
                        })),
                    });

                    // Update cache with new embeddings
                    batchEmbeddings.embeddings.forEach((embedding, index) => {
                        const fileContent = batch[index];
                        this.codehashCache[fileContent.path] = {
                            codehash: fileContent.codehash,
                            embedding: embedding
                        };
                    });
                } catch (error) {
                    console.error('Error embedding documents:', error);
                    // Handle the error as appropriate for your application
                }
            }

            // Save updated cache
            await this.saveCache();

            operationCompleted = true; // -> fetching most relevant files

            // Generate embedding for the query
            const queryEmbedding = await embeddingModel.embedContent({
                content: { role: "query", parts: [{ text: query }] },
                taskType: TaskType.RETRIEVAL_QUERY
            });

            // Calculate the Euclidean distance between the query embedding and each document embedding
            const distances = dartFiles.map((file, index) => ({
                file: file,
                distance: this.euclideanDistance(this.codehashCache[file.path].embedding.values, queryEmbedding.embedding.values)
            }));

            // Sort the files by their distance to the query embedding in ascending order
            distances.sort((a, b) => a.distance - b.distance);

            // Construct a string with the closest Dart files and their content
            let resultString = '';
            for (const fileEmbedding of distances.slice(0, 5)) {
                const fileContent = fileContents.find(fc => fc.path === fileEmbedding.file.path)?.text;
                resultString += fileContent;
            }

            // A list of most relevant file paths
            const filePaths = distances.slice(0, 5).map(fileEmbedding => {
                return fileEmbedding.file.path.split("/").pop();
            });
            this.displayWebViewMessage(view, 'stepLoader', { creatingResultLoader: true, filePaths }); //-> generating results along with file names
            console.log("Most relevant file paths:" + filePaths);

            // Fetching most relevant files
            return resultString.trim();
        } catch (error) {
            console.error("Error finding closest Dart files: ", error);
            throw error; // Rethrow the error to be handled by the caller
        } finally {
            await timeoutPromise;
        }
    }


    private euclideanDistance(a: string | any[], b: number[]) {
        let sum = 0;
        for (let n = 0; n < a.length; n++) {
            sum += Math.pow(a[n] - b[n], 2);
        }
        return Math.sqrt(sum);
    }

    // Converts local file information to a GoogleGenerativeAI.Part object.
    private fileToGenerativePart(path: string, mimeType: string) {
        return {
            inlineData: {
                data: Buffer.from(fs.readFileSync(path)).toString("base64"),
                mimeType
            },
        };
    }

}