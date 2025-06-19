import { ToolDescription } from "../../../shared/tools"

export const morphEditFileDescription: ToolDescription = () => `
Name: morph_edit_file
Description: Use this tool to perform targeted code edits on an existing file using the Morph API. This tool is ideal for making precise modifications to code based on a provided code edit instruction. It reads the original file content, sends it along with the code edit instruction to the Morph API, and receives the updated content. The changes are then presented to the user for approval before being written back to the file.
Parameters:
- path: (required) The path of the file to modify (relative to the current workspace directory /workspaces/Roo-Code)
- code_edit: (required) The code edit instruction to send to the Morph API. This should be a string containing the desired changes in a format understood by the Morph API (e.g., using <code> and <update> tags).
Usage:
<morph_edit_file>
<path>File path here</path>
<code_edit>Your code edit instruction here (e.g., <code>...</code><update>...</update>)</code_edit>
</morph_edit_file>
`
