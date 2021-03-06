// Sigma16: assembler.mjs
// Copyright (C) 2020 John T. O'Donnell
// email: john.t.odonnell9@gmail.com
// License: GNU GPL Version 3 or later. See Sigma16/README.md, LICENSE.txt

// This file is part of Sigma16.  Sigma16 is free software: you can
// redistribute it and/or modify it under the terms of the GNU General
// Public License as published by the Free Software Foundation, either
// version 3 of the License, or (at your option) any later version.
// Sigma16 is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// General Public License for more details.  You should have received
// a copy of the GNU General Public License along with Sigma16.  If
// not, see <https://www.gnu.org/licenses/>.

//------------------------------------------------------------------------------
// assembler.mjs translates assembly language to machine language
//------------------------------------------------------------------------------

import * as com from './common.mjs';
import * as smod from './s16module.mjs';
import * as arch from './architecture.mjs';
import * as arith from './arithmetic.mjs';
import * as st from './state.mjs';

//------------------------------------------------------------------------------
// Global
//------------------------------------------------------------------------------

// Buffers to hold generated object code

let objBufferLimit = 8;             // how many code items to allow per line
let objectWordBuffer = [];          // list of object code words
let relocationAddressBuffer = [];   // list of relocation addresses

//-----------------------------------------------------------------------------
// Assembler state
//-----------------------------------------------------------------------------

// The state is kept in an object created by mkModuleAsm, and stored
// in module m as m.asmInfo

// ??? should take parent module as parameter, and use class notation

export class AsmInfo {
    constructor (parent) {
        this.parent = parent;
	this.modName = "";              // check: should = parent.baseName
        this.text = "";                 // raw source text
        this.asmSrcLines = [];          // list of lines of source text
	this.asmStmt = [];              // statements correspond to lines of source
	this.symbols = [];              // symbols used in the source
	this.symbolTable = new Map ();  // symbol table
	this.locationCounter = 0;       //  next code address
	this.asmListingPlain = [];      // assembler listing
	this.asmListingDec = [];        // decorated assembler listing
	this.objectCode = [];           // string hex representation of object
        this.objectText = "";           // object code as single string
        this.metadata = [];             // lines of metadata code
        this.metadataText = "";         // metadata as single string
        this.asArrMap = [];             // address-sourceline map
        this.imports = [];              // imported module/identifier
        this.exports = [];             // exported identifiers
	this.nAsmErrors = 0;            // errors in assembly source code
    }
    show () {
        let xs = "Assembly language\n";
        xs += `this.parent.baseName\n`;
        xs += this.text;
        return xs;
    }
}

/*
export function mkModuleAsm () {
    com.mode.devlog("mkModuleAsm");
    return {
	modName : "(anonymous)",    // name of module specified in module stmt
        text : "",                  // raw source text
        asmSrcLines : [],           // list of lines of source text
	asmStmt : [],               // statements correspond to lines of source
	symbols : [],               // symbols used in the source
	symbolTable : new Map (),   // symbol table
	locationCounter : null,     //  next code address
	asmListingPlain : [],       // assembler listing
	asmListingDec : [],         // decorated assembler listing
	objectCode : [],            // string hex representation of object
        objectText : "",            // object code as single string
        metadata : [],              // lines of metadata code
        metadataText : "",          // metadata as single string
        asArrMap : [],              // address-sourceline map
        imports : [],               // imported module/identifier
        exports : [],               // exported identifiers
	nAsmErrors : 0              // number of errors in assembly source code
    }
}
*/

//-----------------------------------------------------------------------------
// Character set
//-----------------------------------------------------------------------------

// CharSet is a string containing all the characters that may appear
// in a valid Sigma16 assembly language source program.  It's always
// best to edit source programs using a text editor, not a word
// processor.  Word processors are likely to make character
// substitutions, for example en-dash for minus, typeset quote marks
// for typewriter quote marks, and so on.  Spaces rather than tabs
// should be used for indentation and layout.

const CharSet =
      "_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" // letters
      + "0123456789"              // digits
      + " \t,;\n"                 // separators
      + '"'                       // quotes
      + "'"                       // quotes
      + ".$[]()+-*"               // punctuation
      + "?��`<=>!%^&{}#~@:|/\\";  // other

// removeCR copies a string with all \r characters removed.  In
// Unix/Linux a line ends with \n, but in Windows lines end with \r\n
// (CRLF).  The regular expressions used for parsing assume \n as the
// line terminator.

function removeCR (xs) {
    return xs.split("").filter (c => c.charCodeAt(0) != 13).join("");
    }

// Check that the source code contains only valid characters (defined
// to be characters in CharSet).  Do this check after removing \r
// (carriage return) characters.

function validateChars (xs) {
    com.mode.devlog (`validateChars`);
    let i, c;
    let badlocs = [];
    for (i = 0; i < xs.length; i++) {
        c = xs.charAt(i);
        if (!CharSet.includes(c)) {
            com.mode.errlog (`validateChars: bad char at ${i} in ${xs}`);
            badlocs.push(i);
            com.mode.devlog (`i=${i} charcode=${xs.charCodeAt(i)}`);
        }
    }
    return badlocs
}

//-----------------------------------------------------------------------------
// Symbol table
//-----------------------------------------------------------------------------

// The symbol table is a map from strings to Identifiers, where the
// string is the text of the identifier name, and the Identifier
// object is a record containing all the required information about
// the identifier.

// An Identifier is a symbol table entry: i.e. a record giving all the
// information about an identifier.  It is stored in the symbol table
// keyed by the identifier string.  The name is the identifier string,
// taken from the label field; v is its value, and defline is line
// number where the identifier was defined.

class Identifier {
    constructor (name, mod, extname, v, defLine) {
        this.name = name;
        this.mod = mod;
        this.extname = extname;
        this.value = v;
        this.defLine = defLine;
        this.usageLines = [];
    }
}

function displaySymbolTableHtml (ma) {
    ma.asmListingText.push('');
    ma.asmListingPlain.push('');
    ma.asmListingDec.push('');
    ma.asmListingText.push("Symbol table");
    ma.asmListingPlain.push("<span class='ListingHeader'>Symbol table</span>");
    ma.asmListingDec.push("<span class='ListingHeader'>Symbol table</span>");
    let symtabHeader = "Name        Val Org Mov  Def Used";
    ma.asmListingText.push(symtabHeader);
    ma.asmListingPlain.push(`<span class='ListingHeader'>${symtabHeader}</span>`);
    ma.asmListingDec.push(`<span class='ListingHeader'>${symtabHeader}</span>`);
    let syms  =[ ...ma.symbolTable.keys() ].sort();
    com.mode.devlog (`Symbol table keys = ${syms}`);
    for (let symkey of syms) {
        let x = ma.symbolTable.get (symkey);
        let fullname = x.mod ? `${x.mod}.${x.name}`
            : `${x.name}`;
        let xs = fullname.padEnd(11)
            + x.value.toString()
    	    + x.defLine.toString().padStart(5)
            + '  '
            + x.usageLines.join(',');
        ma.asmListingText.push(xs);
        ma.asmListingPlain.push(xs);
        ma.asmListingDec.push(xs);
    }
}

//-----------------------------------------------------------------------------
// Instruction fields
//-----------------------------------------------------------------------------

export const Field_op = Symbol ("op");
export const Field_d = Symbol ("d");
export const Field_a = Symbol ("a");
export const Field_b = Symbol ("b");
export const Field_disp = Symbol ("disp");
export const Field_e = Symbol ("e");
export const Field_f = Symbol ("f");
export const Field_g = Symbol ("g");
export const Field_h = Symbol ("h");

//-----------------------------------------------------------------------------
// Values
//-----------------------------------------------------------------------------

// A value is a 16-bit word represented as a natural number; it also
// has attributes (origin and movability) that affect its usage.
// Values are produced by evaluating an expression.  Values may be
// used to define instruction fields, and they may also be used as
// arguments to assembler directives.

// Origin attribute
export const Local = Symbol ("Loc");         // defined in this module
export const External = Symbol ("Ext");      // defined in another module

// Movability attribute
export const Fixed = Symbol ("Fix");         // constant
export const Relocatable = Symbol ("Rel");   // changes during relocation

// Add x+y and return the result.  Need ma and s for generating error
// messages.

export function addVal (ma,s,x,y) {
    let result = Zero.copy();
    if (x.origin==External || y.origin==External) {
        mkErrMsg (ma, s, `Cannot perform arithmetic on external value`)
    } else  if (x.movability==Relocatable && y.movability==Relocatable) {
        mkErrMsg (ma, s, `Cannot add two relocatable values`);
    } else {
        let m = x.movability==Relocatable || y.movability==Relocatable
                  ? Relocatable : Fixed;
        result = new Value (wrapWord (x.word + y.word), Local, m);
    }
    console.log (`addVal ${x.word} + ${y.word} = ${result.word}`);
    console.log (`addVal ${x.toString()} +  ${y.toString()}`
                 + ` = ${result.toString()}`);
    return result;
}

// Word addition doesn't overflow, but wraps around.  Any negative
// would be an internal error, and is set to 0 with message.

function wrapWord (x) {
    if (x<0) {
        console.log (`Internal error: wrapWord ${x}`);
        x = 0;
    }
    return x; // check for neg, and mod
}

export class Value {
    constructor (v, o, m) {
        this.word = v;
        this.origin = o;
        this.movability = m;
    }
    copy () {
        return new Value (this.word, this.origin, this.movability);
    }
    add (k) {
        this.word = this.word + k.word;
        this.movability =
            k.movability==Fixed ? this.movability
            : this.movability==Fixed ? k.movability
            : Fixed;
    }
    toString () {
        let xs =  `${arith.wordToHex4(this.word)}`
            + ` ${this.origin.description}`
            + ` ${this.movability.description}`
        return xs;
    }
}

const ExtVal = new Value (0, External, Fixed);

function mkConstVal (k) { return new Value (k, Local, Fixed); }
const Zero = mkConstVal (0);
const One  = mkConstVal (1);
const Two  = mkConstVal (2);

//-----------------------------------------------------------------------------
// Evaluation of expressions
//-----------------------------------------------------------------------------

// An expression is assembly language syntax that specifies a value.
// The assembler evaluates expressions to calculate the corresponding
// value.

// Expressions are assembly language syntax to define values that
// appear in the machine language code.  Expression evaluation occurs
// at assembly time.  The object code contains only words, but cannot
// contain expressions.

//   nonnegative decimal integer:   0, 34       fixed
//   negative decimal integer:      -103        fixed
//   identifier:                    xyz, loop   fixed or relocatable
//   Later, will allow limited arithmetic on expressions

// The evaluator takes an expression and environment and returns a
// value, which may be either fixed or relocatable.

// Arguments: m is module, s is statement, a is address where the
// value will be placed (the address a is passed in because the word
// being evaluated could appear in the second word of an instruction
// (for RX etc), or any word (in the case of a data statement)).

// Evaluate returns a word which will be inserted into the object code
// during pass 2.  This could be the actual final value (if it's a
// relocatable label) or a placeholder value of 0 (if it's an import).
// Evaluate also records additional information about any symbols that
// appear in the expression: the definition line (used for printing
// the symbol table in the assembly listing) and the (relocatable)
// address where the symbol appears (to enable the linker to insert
// the values of imports).  If an imported name appears in an
// expression, the expression must consist entirely of that name: for
// example, x+1 is legal if x is a local name but not if x is an
// import.

// s and a are needed to record the usage line of any identifiers that
// occur in x.

function evaluate (ma, s, a, x) {
    com.mode.devlog(`Enter evaluate ${typeof(x)} <${x}>`);
    let result;
    if (x.search(nameParser) == 0) { // identifier
	let r = ma.symbolTable.get(x);
	if (r) {
            result = r.value.copy(); // identifier already has a value, return it
            r.usageLines.push (s.lineNumber+1);
	} else {
            mkErrMsg (ma, s, 'symbol ' + x + ' is not defined');
            result = mkConstVal(0); // new Value (0, Local, Fixed);
	}
    } else if (x.search(intParser) == 0) { // integer literal
 //        result = new Value (arith.intToWord(parseInt(x,10)), Local, Fixed);
        result = mkConstVal(arith.intToWord(parseInt(x,10)));
    } else if (x.search(hexParser) == 0) { // hex literal
//      result =  new Value (arith.hex4ToWord(x.slice(1)), Local, Fixed);
        result =  mkConstVal (arith.hex4ToWord(x.slice(1)));
    } else { // compound expression (not yet implemented)
        mkErrMsg (ma, s, 'expression ' + x + ' has invalid syntax');
        result = Zero.copy(); // new Value (0, Local, Fixed);
    }
//    com.mode.devlog (`evaluate received expression ${x}`)
    com.mode.trace = true;
    com.mode.devlog (`evaluate ${x} returning (${result.toString()})`)
    com.mode.trace = false;
    return result;
}

//-----------------------------------------------------------------------------
// Assembly language statement
//-----------------------------------------------------------------------------

// Each statement has a listing line which contains the line number,
// object code, and source code.  There are two versions of this:
// listingLinePlain just contains the text of the listing line, while
// listingLineHighlightedFields contains <span> elements to enable the
// various fields to be highlighted with colors.

function showAsmStmt (s) {
    com.mode.devlog (`*** showAsmStmt line=${s.lineNumber}`);
    com.mode.devlog (`*** srcLine=${s.srcLine}`);
    com.mode.devlog (`*** address=${s.address}`);
}

function mkAsmStmt (lineNumber, address, srcLine) {
    console.log (`@@@@@@@@ mkAsmStmt ${address.toString()}`);
    return {lineNumber,                        // array index of statement
	    address,                           // address where code goes
	    srcLine,                           // source line
	    listingLinePlain: "",              // object and source text
	    listingLineHighlightedFields : "", // listing with src field spans
	    fieldLabel : '',                   // label
	    fieldSpacesAfterLabel : '',        // white space
	    fieldOperation : '',               // operation mnemonic
	    fieldSpacesAfterOperation : '',    // white space
	    fieldOperands : '',                // operands
	    fieldComment : '',                 // comments are after operand or ;
	    hasLabel : false,                  // statement has a valid label
            operation : null,                  // spec of the operation if exists
            operands : [],                     // array of individual operands
	    codeSize : Zero,                   // number of words generated
	    orgAddr : -1,                      // address specified by org/block
	    codeWord1 : null,                  // first word of object
	    codeWord2 : null,                  // second word of object
	    errors : []                        // array of lines of error messages
	   }
}

// Print the object representing a source line; for testing

function printAsmStmt (ma,x) {
    console.log('Statement ' + x.lineNumber + ' = /' + x.srcLine + '/');
    console.log('  label field /' + x.fieldLabel + '/');
    console.log('  spaces after label /' + x.fieldSpacesAfterLabel + '/');
    console.log('  operation field /' + x.fieldOperation + '/');
    console.log('  spaces after operation /' +
		x.fieldSpacesAfterOperation + '/');
    console.log('  operand field /' + x.fieldOperands + '/');
    console.log('  comment /' + x.fieldComment + '/');
    console.log (x.hasLabel ? ('  label = ' + x.fieldLabel) : '  no label');
    console.log ('  d=' + x.d + ' a=' + x.a + ' b=' + x.b
		 + ' disp=' + x.field_disp + ' dat=' + x.dat);
    console.log ('  address = ' + x.address
		 + ' codesize=' + x.codeSize.word
		 + ' codeWord1=' + x.codeWord1 + ' codeWord2=' + x.codeWord2);
    if (x.errors.length > 0) {
	console.log ('error messages:\n' + x.errors.join('\n'));
    } else {
	console.log ('no errors detected');
    }
}

//-----------------------------------------------------------------------------
//  Error messages
//-----------------------------------------------------------------------------

// Report an assembly error: s is an assembly source line, err is an
// error message

function mkErrMsg (ma,s,err) {
    console.log (err);
    s.errors.push(err);
    ma.nAsmErrors++;
}

//-----------------------------------------------------------------------------
// Interfaces to the assembler
//-----------------------------------------------------------------------------

// When Assembler pane is entered, if an AsmInfo doesn't exist then
// create one and insert it into the current module.  Copy the text of
// the current module into the AsmInfo.

export function enterAssembler () {
    let m = smod.getSelectedModule ();
    if (!m.asmInfo) {
        m.asmInfo = mkModuleAsm ();
    }
    m.asmInfo.asmSrcLines = m.text.split('\n');
}

// Interface to assembler for use in the GUI

export function assemblerGUI () {
    com.mode.devlog ("assemblerGUI starting");
    let m = smod.getSelectedModule ();
    let ma =  mkModuleAsm ();
    m.asmInfo = ma;
    ma.text = m.text;
    document.getElementById('AsmTextHtml').innerHTML = ""; // clear text in asm
    document.getElementById('ProcAsmListing').innerHTML = ""; // clear text in proc
    com.clearObjectCode (); // clear text in linker pane
    assembler (ma);
    setAsmListing (m);
    if (ma.nAsmErrors > 0) {
        document.getElementById('ProcAsmListing').innerHTML = "";
    }
}
    
// Interface to assembler for use in the command line interface

// Obsolete, changing to assembleCLI in cli/Sigma16.mjs

/*
export function assemblerCLI (src) {
    com.mode.devlog ("assemblerCLI starting");
    let ma = mkModuleAsm ();
    ma.text = src;
    assembler (ma);
    return ma;
 }
*/

//-----------------------------------------------------------------------------
//  Assembler
//-----------------------------------------------------------------------------

// assembler translates assembly language source code to object code,
// and also produces an assembly listing and metadata.  The source is
// obtained from the ma object, and the results are placed there.
// This is the main translator, used for both gui and cli Input:
// ma.asmSrcLines contains array of lines of source code Result:
// define the fields in ma

export function assembler (ma) {
    let src = ma.text;
    console.log (src);
    let src2 = removeCR (src);
//    let badlocs = validateChars (src2);
    ma.asmSrcLines = src2.split("\n");
    com.mode.devlog (`assembler nloc=${ma.asmSrcLines.length}`);

//    ma.modName = null;
    ma.nAsmErrors = 0;
    ma.asmStmt = [];
    ma.symbols = [];
    ma.asmListingText = [];
    ma.asmListingPlain = [];
    ma.asmListingDec = [];
    ma.objectCode = [];
    ma.exports = [];
    ma.locationCounter = new Value (0, Local, Relocatable);
    ma.asArrMap = [];
    ma.symbolTable.clear();
    ma.asmListingText.push ("Line Addr Code Code Source");
    ma.asmListingPlain.push(
	"<span class='ListingHeader'>Line Addr Code Code Source</span>");
    ma.asmListingDec.push(
	"<span class='ListingHeader'>Line Addr Code Code Source</span>");
    asmPass1 (ma);
    asmPass2 (ma);
    if (ma.nAsmErrors > 0) {
	ma.asmListingText.unshift
          (`\n ${ma.nAsmErrors} errors detected\n`,'ERR');
        	ma.asmListingPlain.unshift (com.highlightField
           (`\n ${ma.nAsmErrors} errors detected\n`,'ERR'));
        	ma.asmListingDec.unshift (com.highlightField
           (`\n ${ma.nAsmErrors} errors detected\n`,'ERR'));
    }
    ma.asmListingPlain.unshift("<pre class='HighlightedTextAsHtml'>");
    ma.asmListingDec.unshift("<pre class='HighlightedTextAsHtml'>");
    displaySymbolTableHtml(ma);
    ma.asmListingPlain.push("</pre>");
    ma.asmListingDec.push("</pre>");
}

//-----------------------------------------------------------------------------
//  Regular expressions for the parser
//-----------------------------------------------------------------------------

// Syntax of assembly language

// a constant value is
// a label is   (?:[a-zA-Z][a-zA-Z0-9]*)
// $ followed by 4 hex digits      (?:\$[0-9a-f]{4})
//  a decimal number with optional sign   (?:-?[0-9]+)

/* An assembly language line consists of four fields separated by
white space.  Everything following a semicolon ; is a comment.

label
   anchored at beginning of line
   may be empty string (if first character is ; or space)
   contains any characters apart from whitespace or ;
spacesAfterLabel
operation
spacesAfterOperation
operands
comments field
   anchored at end of line
   contains any characters
*/

const identParser = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const nameParser = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const intParser = /^-?[0-9]+$/;
const hexParser = /^\$([0-9a-f]{4})$/;
const regParser = /^R([0-9a-f]|(?:1[0-5]))$/;
const xParser = /^([-a-zA-Z0-9_\$]+)\[R([0-9a-f]|(?:1[0-5]))\]/;

const rrParser =
    /^R([0-9a-f]|(?:1[0-5])),R([0-9a-f]|(?:1[0-5]))$/;
const rxParser =
    /^R([0-9a-f]|(?:1[0-5])),(-?[a-zA-Z0-9_\$]+)\[R([0-9a-f]|(?:1[0-5]))\]/;
const kxParser =
    /^([0-9a-f]|(?:1[0-5])),(-?[a-zA-Z0-9_\$]+)\[R([0-9a-f]|(?:1[0-5]))\]/;
const rrxParser =
    /^R([0-9a-f]|(?:1[0-5])),R([0-9a-f]|(?:1[0-5])),(-?[a-zA-Z0-9_\$]+)\[R([0-9a-f]|(?:1[0-5]))\]/;
const datParser =
    /^(((?:[a-zA-Z][a-zA-Z0-9_]*)|(?:\$[0-9a-f]{4})|(?:-?[0-9]+)))$/;

// A register is R followed by register number, which must be either
// a 1 or 2 digit decimal number between 0 and 15, or a hex digit.
// An aRRR operand consists of three registers, separated by comma
// An RRRR operand consists of four registers, separated by comma

const rrrrParser =
    /^R([0-9a-f]|(?:1[0-5])),R([0-9a-f]|(?:1[0-5])),R([0-9a-f]|(?:1[0-5])),R([0-9a-f]|(?:1[0-5]))$/;
const rrkParser =
    /^R([0-9a-f]|(?:1[0-5])),R([0-9a-f]|(?:1[0-5])),([0-9][0-9]?)$/;
const rrrkParser =
    /^R([0-9a-f]|(?:1[0-5])),R([0-9a-f]|(?:1[0-5])),R([0-9a-f]|(?:1[0-5])),([0-9][0-9]?)$/;
const rrrkkParser =
    /^R([0-9a-f]|(?:1[0-5])),R([0-9a-f]|(?:1[0-5])),R([0-9a-f]|(?:1[0-5])),([0-9][0-9]?),([0-9][0-9]?)$/;
const rkkParser =
    /^R([0-9a-f]|(?:1[0-5])),([0-9][0-9]?),([0-9][0-9]?)$/;
const rrkkParser =
    /^R([0-9a-f]|(?:1[0-5])),R([0-9a-f]|(?:1[0-5])),([0-9][0-9]?),([0-9][0-9]?)$/;
// aRC asm format (register, control reg name): getctl R3,mask
const rcParser =
    /^R([0-9a-f]|(?:1[0-5])),([a-zA-Z][a-zA-Z0-9]*)$/;
const nameNameParser = // import statement
      /^([a-zA-Z][a-zA-Z0-9_]*),([a-zA-Z][a-zA-Z0-9_]*)$/;
      
// A string literal consists of arbitrary text enclosed in "...", for
// example "hello".  String literals are most commonly used in data
// statements, but a string literal containing just one character can
// also be used in a lea instruction.  If a string literal contains a
// double quote ", this must be preceded by a backslash to escape it.

// parseString: match " followed by any number of (\" or ^") followed
// by ".  It's important to check for the 2-character sequence \"
// before checking for the single character ^" --- otherwise the \
// will match the ^" so the following " will end the string
// prematurely.
// a quoted character is \x where x is any character; backslash is \\

const parseString = /"((\\")|[^"])*"/;

// Split into line fields: non-space characters but space can appear in string
// A field is (non-whitespace | string) *
// String is " (non" | \" )* "

// name: may contain letters, digits, underscore; must begin with letter
// decimal number: optional - followed by digits
// hex number: $ followed by four hex digits (a/A are both ok)
// character: 'x' where x is any character. a quote is '\''. ',' is ok

// field: continguous non-space characters, separated from other
// fields by white space.  The first field must begin in the first
// column, i.e. cannot follow any white space.  A field may contain a
// string literal, which might contain one or more white space
// characters.

// The rrxParser accepts any string that contains the characters that
// are legal for the displacement field, but the field needs to be
// checked for validity (e.g. 23xy is not a valid displacement).

const regExpField = '((?:(?:(?:"(?:(?:\\")|[^"])*")|[^\\s";])+)?)';

// A field may contain non-space characters, and may contain a string
// literal, but cannot contain a space or ; (unless those appear in a
// string literal).  The field terminates as soon as a space or ; or
// end of the line is encountered.

// Simplified version of field: don't allow string literals
const regexpFieldNoStringLit =  '((?:[^\\s";]*)?)'

const regExpWhiteSpace = '((?:\\s+)?)';
const regExpComment = '((?:.*))';

const regexpSplitFields =
      '^'                             // anchor to beginning of line
      + regexpFieldNoStringLit        // label
      + regExpWhiteSpace              // separator
      + regexpFieldNoStringLit        // operation
      + regExpWhiteSpace              // separator
      + regexpFieldNoStringLit        // operands
      + regExpComment                 // comment
      + '$';                          // anchor to end of line

const parseField = new RegExp(regExpField);
const parseSplitFields = new RegExp(regexpSplitFields);

function requireX (ma, s, field) {
    const x = xParser.exec (field);
    let result = {disp: "0", index: 0};
    if (x) {
        const {0:all, 1:disp, 2:index} = x;
        com.mode.devlog (`requireX 0=${all} 1=${disp} 2=${index}`);
        result = {disp,index};
    } else {
        const displayField = field ? field : "";
        mkErrMsg (ma, s, `operand ${displayField} is not disp[reg]`);
    }
    com.mode.devlog (`requireX ${field} return ${result.disp} ${result.index}`);
    return result;
}

// requireK4: obtain a 4-bit word from source.  The context is ma and
// statement s.  xs is a text field from assembly language source; it
// should evaluate to a 4-bit constant and be placed in "field" in the
// object code word at address a.  The value will not be relocated,
// but it could be imported.

// ??? todo  Generate import if necessary
// ??? todo  give message if result>15

// k4 is always fixed, never relocatable

function requireK4 (ma, s, field, xs) {
    console.log (`requireK4 ${xs}`);
    const a = s.address.word;
    const v = evaluate (ma, s, a, xs);
    const result = v.word;
    return result;
}

// k8 is always fixed, never relocatable, and is always in the gh field

// ma is assembler context, s is statement, a is address where the k8
// field will be inserted, field is the name of the field where it
// will be inserted (currently this will always be gh field), and xs
// is the source string specifying the value.

function requireK8 (ma, s, a, field, xs) {
    console.log (`requireK8 ${xs}`);
    const v = evaluate (ma, s, a, xs);
    const result = v.word;
    return result;
}

function requireReg (ma,s,field) {
    const x =  regParser.exec (field);
    let n = 0;
    if (x) {
        n = x[1];
    } else {
        const displayField = field ? field : "";
        mkErrMsg (ma, s, `operand ${displayField} is not a valid register`);
        n = 0;
    }
    console.log (`requireReg field=${field} result=${n}`);
    return n;
}

//-----------------------------------------------------------------------------
//  Parser
//-----------------------------------------------------------------------------

// Parse the source for line i and update the object with the results.
// Each source line is a statement; a statement consists of a sequence
// of fields and whitespace-fields.  Each is optional.  The structure
// is:

// label, whitespace, operation, whitespace, operands, whitespace

function parseAsmLine (ma,i) {
    com.mode.devlog (`parseAsmLine i=${i}`);
    let s = ma.asmStmt[i];
    showAsmStmt(s);
    let p = parseSplitFields.exec(s.srcLine);
    s.fieldLabel = p[1];
    s.fieldSpacesAfterLabel = p[2];
    s.fieldOperation = p[3];
    s.fieldSpacesAfterOperation = p[4];
    s.fieldOperands = p[5];
    s.fieldComment = p[6];
    parseLabel (ma,s);
    parseOperation (ma,s);
    s.operands = s.fieldOperands.split(',');
    com.mode.trace = true;
    com.mode.devlog (`ParseAsmLine ${s.lineNumber}`);
    com.mode.devlog (`  fieldLabel = ${s.hasLabel} /${s.fieldLabel}/`);
    com.mode.devlog (`  fieldOperation = /${s.fieldOperation}/`);
    com.mode.devlog (`  operation = ${showOperation(s.operation)}`);
    com.mode.devlog (`  fieldOperands = /${s.fieldOperands}/`);
    com.mode.devlog (`  operands = ${s.operands}`);
    com.mode.devlog (`  fieldComment = /${s.fieldComment}/`);
    com.mode.trace = false;
}

// Set hasLabel to true iff there is a syntactically valid label.  If
// the label field isn't blank but is not syntactically valid
// (i.e. doesn't match the regular expression for names), then
// generate an error message.

function parseLabel (ma,s) {
    if (s.fieldLabel == '') {
	s.hasLabel = false;
    } else if (s.fieldLabel.search(nameParser) == 0) {
	s.hasLabel = true;
    } else {
	s.hasLabel = false;
        mkErrMsg(ma, s, s.fieldLabel + ' is not a valid label');
    }
}


// Set operation to the instruction set object describing the
// operation, if the operation field is defined in the map of
// operations.  Otherwise leave operation=null.  Thus s.operation can
// be used as a Boolean to determine whether the operation exists, as
// well as the specification of the operation if it exists.

function parseOperation (ma,s) {
    let op = s.fieldOperation;
    com.mode.devlog (`parseOperation line ${s.lineNumber} op=${op}`);
    if (op !== '') {
	let x = arch.statementSpec.get(op);
	if (x) {
            com.mode.devlog (`parseOperation: found statementSpec ${x}`);
	    s.operation = x;
            if (s.operation.ifmt==arch.iDir
                && s.operation.afmt==arch.aModule) {
                ma.modName = s.fieldLabel;
                com.mode.devlog (`parseOperation module=${ma.modName}`);
            } else if (s.operation.ifmt==arch.iData
                       && s.operation.afmt==arch.aData) {
                s.codeSize = One.copy();
            } else if (s.operation.ifmt==arch.iDir
                       && s.operation.afmt==arch.aOrg) {
                let y = evaluate (ma, s, ma.locationCounter, s.fieldOperands);
                s.orgAddr = y.value;
                console.log (`parse Operation orgAddr=${s.orgAddr}`);
            } else if (s.operation.ifmt==arch.iDir
                       && s.operation.afmt==arch.aBlock) {
                let y = evaluate (ma, s, ma.locationCounter, s.fieldOperands);
                s.orgAddr = mkConstVal (ma.locationCounter.word + y.word);
                console.log (`parse Op BLOCK orgAddr=${s.orgAddr.toString()}`);
            } else {
	        s.codeSize = mkConstVal(arch.formatSize(x.ifmt));
            }
	} else {
            s.operation = arch.emptyOperation;
            //            s.codeSize = 0;
            s.codeSize = Zero;
            // GIVE ERROR MESSAGE ?????
	}
    } else {
        s.operation = arch.emptyOperation;
    }
}

//-----------------------------------------------------------------------------
//  Assembler Pass 1
//-----------------------------------------------------------------------------

// Pass 1 parses the source, calculates the code size for each
// statement, defines labels, and maintains the location counter.
// Requires that asmSrcLines has been set to the source code, split
// into an array of lines of text.

function asmPass1 (ma) {
    com.mode.devlog('Assembler Pass 1: ' + ma.asmSrcLines.length + ' source lines');
    for (let i = 0; i < ma.asmSrcLines.length; i++) {
        com.mode.devlog (`Pass 1 i=${i} line=<${ma.asmSrcLines[i]}>`);
	ma.asmStmt[i] = mkAsmStmt (i, ma.locationCounter.copy(), ma.asmSrcLines[i]);
	let s = ma.asmStmt[i];
        let badCharLocs = validateChars (ma.asmSrcLines[i]);
        com.mode.devlog (`validateChars: badCharLocs=${badCharLocs}`);

        if (badCharLocs.length > 0) {
            mkErrMsg (ma,s,`Invalid character at position ${badCharLocs}`);
            mkErrMsg (ma,s, "See User Guide for list of valid characters");
            mkErrMsg (ma,s, "(Word processors often insert invalid characters)");
        }
        parseAsmLine (ma,i);
        com.mode.trace = true;
        com.mode.devlog (`Pass 1 ${i} /${s.srcLine}/`
                         + ` address=${s.address} codeSize=${s.codeSize}`);
        handleLabel (ma,s);
        updateLocationCounter (ma,s,i);
    }
}

// Define identifier appearing in label field

function handleLabel (ma,s) {
    if (s.hasLabel) {
        com.mode.trace = true;
        com.mode.devlog (`ParseAsmLine label ${s.lineNumber} /${s.fieldLabel}/`);
	if (ma.symbolTable.has(s.fieldLabel)) {
            mkErrMsg (ma, s, s.fieldLabel + ' has already been defined');
        } else if (s.fieldOperation==="module") {
            com.mode.devlog (`Parse line ${s.lineNumber} label: module`);
        } else if (s.fieldOperation==="equ") {
            let v = evaluate (ma, s, ma.locationCounter, s.fieldOperands);
            let i = new Identifier (s.fieldLabel, null, null, v, s.lineNumber+1);
            ma.symbolTable.set (s.fieldLabel, i);
            com.mode.devlog (`Parse line ${s.lineNumber} set ${i.toString()}`);
        } else if (s.fieldOperation==="import") {
            let mod = s.operands[0];
            let extname = s.operands[1];
            let v = ExtVal.copy();
            let i = new Identifier (s.fieldLabel, mod, extname, v, s.lineNumber+1);
            ma.symbolTable.set (s.fieldLabel, i);
            com.mode.devlog (`Label import ${s.lineNumber} locname=${s.fieldLabel}`
                             + ` mod=${mod} extname=${extname}`);
        } else {
            let v = ma.locationCounter.copy();
            console.log (`def label lc = ${ma.locationCounter.toString()}`);
            console.log (`def label v = ${v.toString()}`);
            let i = new Identifier (s.fieldLabel, null, null, v, s.lineNumber+1);
            com.mode.devlog (`Parse line ${s.lineNumber} label ${s.fieldLabel}`
                             + ` set ${i.toString()}`);
            ma.symbolTable.set (s.fieldLabel, i);
        }
    }
}

function updateLocationCounter (ma,s,i) {
            com.mode.devlog (`Pass 1 ${i} @ was ${ma.locationCounter.toString()}`);
        if (s.operation.ifmt==arch.iDir && s.operation.afmt==arch.aOrg) {
            let v = evaluate (ma, s, ma.locationCounter, s.fieldOperands);
            console.log (`Org v= ${v.toString()}`);
            ma.locationCounter = v.copy();
            com.mode.devlog (`org ${i} ${ma.locationCounter.toString()}`);
        } else if (s.operation.ifmt==arch.iDir && s.operation.afmt==arch.aBlock) {
            let v = evaluate (ma, s, ma.locationCounter, s.fieldOperands);
            if (v.movability==Fixed) {
                console.log (`Block v= ${v.toString()}`);
                ma.locationCounter = addVal(ma,s,ma.locationCounter,v).copy();
                com.mode.devlog (`block ${i} ${ma.locationCounter.toString()}`);
            } else {
                mkErrMsg (ma, s, `operand for block must be Fixed`);
            }
        } else {
            console.log (`Pass1 code codesize=${s.codeSize.toString()}`);
            ma.locationCounter = addVal (ma, s, ma.locationCounter, s.codeSize);
            com.mode.devlog (`code ${i} ${ma.locationCounter.toString()}`);
        }
        com.mode.trace = false;
    }

function printAsmStmts (ma) {
    for (let i = 0; i < ma.asmStmt.length; i++) {
	printAsmStmt(ma.asmStmt[i]);
    }
}

// Given a string xs, either return the control register index for it
// if xs is indeed a valid control register name; otherwise generate
// an error message.

function findCtlIdx (ma,s,xs) {
    let c = arch.ctlReg.get(xs);
    let i = 0;
    if (c) {
	i = c.ctlRegIndex;
    } else {
        mkErrMsg (ma,s,`${xs} is not a valid control register`);
    }
    com.mode.devlog (`findCtlIdx ${xs} => ${i}`);
    return i;
}

//-----------------------------------------------------------------------------
//  Pass 2
//-----------------------------------------------------------------------------

// Make a code word from four 4-bit fields

function mkWord (op,d,a,b) {
    let clear = 0x000f;
    return ((op&clear)<<12) | ((d&clear)<<8) | ((a&clear)<<4) | (b&clear);
}

// Make a code word from two 4-bit fields and an 8 bit field (EXP format)

function mkWord448 (op,d,k) {
    let clear4 = 0x000f;
    let clear8 = 0x00ff;
    return ((op&clear4)<<12) | ((d&clear4)<<8) | (k&clear8);
}

function testWd(op,d,a,b) {
    console.log(arith.wordToHex4(mkWord(op,d,a,b)));
}

// imports are handled in Pass 1 because they define labels; exports
// are handled in Pass2 because they use labels.

function asmPass2 (ma) {
    com.mode.devlog('Assembler Pass 2');
    objectWordBuffer = [];
    relocationAddressBuffer = [];
    ma.objectCode.push (`module   ${ma.modName}`);
    for (let i = 0; i < ma.asmStmt.length; i++) {
	let s = ma.asmStmt[i];
	com.mode.devlog(`Pass2 line ${s.lineNumber} = /${s.srcLine}/`);
        console.log (`>>> pass2 operands = ${s.operands}`);
        let op = s.operation;
        com.mode.devlog (`Pass2 op ${s.fieldOperation} ${showOperation(op)}`);
        console.log (`Pass2 op ifmt=${op.ifmt.description} afmt=${op.afmt.description} pseudo=${op.pseudo}`);
// Directives        
        if (op.ifmt==arch.iDir && [arch.aBlock,arch.aOrg].includes(op.afmt)) {
            let a = s.orgAddr;
            let ahex = arith.wordToHex4 (a)
            console.log (`Pass 2 org/block a=${a} ahex=${ahex}`);
            emitObjectWords (ma);
            let stmt = `org      ${ahex}`
            ma.objectCode.push (stmt);
        } else if (op.ifmt==arch.iRRR && op.afmt==arch.aRRR) {
            
// RRR-RRR
            com.mode.devlog (`pass2 iRRR/aRRR`);
            const d = requireReg(ma,s,s.operands[0]);
            const a = requireReg(ma,s,s.operands[1]);
            const b = requireReg(ma,s,s.operands[2]);
            com.mode.devlog (`RRR noperands = ${s.operands.length}`)
            s.codeWord1 = mkWord (op.opcode[0], d, a, b);
            generateObjectWord (ma, s, s.address.word, s.codeWord1);
	} else if (op.ifmt==arch.iRRR && op.afmt==arch.aRR) {

// RRR-RR            
	    com.mode.devlog (`Pass2 iRRR/aRR`);
            const d = 0;
            const a = requireReg(ma,s,s.operands[0]);
            const b = requireReg(ma,s,s.operands[1]);
	    s.codeWord1 = mkWord (op.opcode[0], d, a, b);
            generateObjectWord (ma, s, s.address.word, s.codeWord1);

// RX-RX
	} else if (op.ifmt==arch.iRX && op.afmt==arch.aRX) {
	    com.mode.devlog (`Pass2 RX/RX`);
            const d = requireReg(ma,s,s.operands[0]);
            const {disp,index} = requireX(ma,s,s.operands[1]);
            console.log (`RX/RX disp = /${disp}/`)
            let a = index;
            let b = op.opcode[1];
            let v = evaluate (ma, s, s.address.word+1, disp);
            if (v.evalRel) {
                generateRelocation (ma, s, s.address.word+1);
            }
            com.mode.devlog (`pass 2 RX/RX a=${a} b=${b} v=${v.toString()}`);
            s.codeWord1 = mkWord (op.opcode[0], d, a, b);
            s.codeWord2 = v.word;
	    generateObjectWord (ma, s, s.address.word, s.codeWord1);
	    generateObjectWord (ma, s, s.address.word+1, s.codeWord2);
            handleVal (ma, s, s.address.word+1, disp, v, Field_disp);

// RX-X pseudo
        } else if (op.ifmt==arch.iRX && op.afmt==arch.aX && op.pseudo) {
	    com.mode.devlog (`Pass2 RX/X pseudo`);
            console.log ("RX-X pseudo");
            const x = xParser.exec  (s.fieldOperands);
            if (x) {
                const {1:disp, 2:a} = x;
                let b = op.opcode[1];
                let d = op.opcode[2];
                let v = evaluate (ma, s, s.address.word+1, disp);
                if (v.evalRel) {
                    com.mode.devlog (`relocatable displacement`);
                    generateRelocation (ma, s, s.address.word+1);
                }
	        s.codeWord1 = mkWord (op.opcode[0], d, a, b);
                s.codeWord2 = v.word;
	        generateObjectWord (ma, s, s.address.word, s.codeWord1);
	        generateObjectWord (ma, s, s.address.word+1, s.codeWord2);
            } else {
                mkErrMsg (ma, s, `ERROR operation requires X operand`);
            }
            
// RX-X --- jump L1[R0]
	} else if (op.ifmt==arch.iRX && op.afmt==arch.aX && !op.pseudo) {
            com.mode.devlog (`Pass2 RX/X)`);
            console.log (`RX/X real ${s.operands[0]}`);
            const d = 0;
            const {disp,index} = requireX(ma,s,s.operands[0]);
            console.log (`RX/X disp = /${disp}/`)
            let a = index;
            let b = op.opcode[1];
            let v = evaluate (ma, s, s.address.word+1, disp);
            if (v.evalRel) {
                generateRelocation (ma, s, s.address.word+1);
            }
            s.codeWord1 = mkWord (op.opcode[0], d, a, b);
            s.codeWord2 = v.word;
	    generateObjectWord (ma, s, s.address.word, s.codeWord1);
	    generateObjectWord (ma, s, s.address.word+1, s.codeWord2);

// RX-kX
        } else if (op.ifmt==arch.iRX && op.afmt==arch.akX) {
	    com.mode.devlog (`pass2 RX/kX`);
            const k = evaluate (ma, s, s.address.word, s.operands[0])
            const d = k.word;
            const {disp,index} = requireX(ma,s,s.operands[1]);
            let a = index;
            let b = op.opcode[1];
            let v = evaluate (ma, s, s.address.word+1, disp);
            s.codeWord1 = mkWord (op.opcode[0], d, a, b);
            s.codeWord2 = v.word;
	    generateObjectWord (ma, s, s.address.word, s.codeWord1);
	    generateObjectWord (ma, s, s.address.word+1, s.codeWord2);
            handleVal (ma, s, s.address.word, s.operands[0], k, Field_d);
            handleVal (ma, s, s.address.word+1, disp, v, Field_disp);


// EXP1-null -- resume
	} else if (op.ifmt==arch.iEXP1 && op.afmt==arch.a0) {
	    com.mode.devlog (`Pass2 iEXP1/no-operand`);
            if (s.fieldOperands=="") {
	        s.codeWord1 = mkWord448(op.opcode[0],0,op.opcode[1]);
	        generateObjectWord (ma, s, s.address.word, s.codeWord1);
            } else {
                mkErrMsg (ma, s, `this instruction requires no operands`);
            }

// EXP2-RkkRk extract            
        } else if (op.ifmt==arch.iEXP2 && op.afmt==arch.aRkkRk ) {
            com.mode.devlog (`Pass2 iEXP2/aRkRRk`);
            console.log (`Pass2 EXP2-RkRRk`);
            const d = requireReg (ma, s, s.operands[0]);
            const e = requireK4  (ma, s, Field_e, s.operands[1]);
            const f = requireK4  (ma, s, Field_f, s.operands[2]);
            const g = requireReg (ma, s, s.operands[3]);
            const h = requireK4  (ma, s, Field_h, s.operands[4]);
            s.codeWord1 = mkWord448 (op.opcode[0], d, op.opcode[1]);
            s.codeWord2 = mkWord (e, f, g, h);
            generateObjectWord (ma, s, s.address.word, s.codeWord1);
            generateObjectWord (ma, s, s.address.word+1, s.codeWord2);

// EXP2-RR
	} else if (op.ifmt==arch.iEXP2 && op.afmt==arch.aRR) {
	    com.mode.devlog (`pass2 iEXP2/aRR`);
            const x = rrParser.exec (s.fieldOperands);
            if (x) {
                const {1:d, 2:e} = x;
                let f = 0;
                let g = arith.logicFunction(s.fieldOperation);
                let h = 0;
	        s.codeWord1 = mkWord448 (op.opcode[0], d, op.opcode[1]);
                s.codeWord2 = mkWord (e, f, g, h);
                generateObjectWord (ma, s, s.address.word, s.codeWord1);
                generateObjectWord (ma, s, s.address.word+1, s.codeWord2);
            } else {
                mkErrMsg (ma, s, `ERROR operation requires RR operands`);
            }

// EXP2-RRR            
	} else if (op.ifmt==arch.iEXP2 && op.afmt==arch.aRRR && op.pseudo) {
            com.mode.devlog ('Pass2 EXP2/RRR pseudo (logicw)');
            const d = requireReg (ma, s, s.operands[0]);
            const e = requireReg (ma, s, s.operands[1]);
            const f = requireReg (ma, s, s.operands[2]);
            const g = 0;
            const h = op.opcode[2];
	    s.codeWord1 = mkWord448 (op.opcode[0], d, op.opcode[1]);
            s.codeWord2 = mkWord (e, f, g, h);
            generateObjectWord (ma, s, s.address.word, s.codeWord1);
            generateObjectWord (ma, s, s.address.word+1, s.codeWord2);

// EXP2-Rkkkk
	} else if (op.ifmt==arch.iEXP2 && op.afmt==arch.aRkkkk) {
            com.mode.devlog ('Pass2 EXP2/Rkkkk (logicb)');
            const addr = s.address.word;
            const d = requireReg(ma,s,s.operands[0]);
            const e = requireK4 (ma, s, addr, Field_e, s.operands[1]);
            const f = requireK4 (ma, s, addr, Field_f, s.operands[2]);
            const g = requireK4 (ma, s, addr, Field_g, s.operands[3]);
            const h = requireK4 (ma, s, addr, Field_h, s.operands[4]);
	    s.codeWord1 = mkWord448 (op.opcode[0], d, op.opcode[1]);
            s.codeWord2 = mkWord (e, f, g, h);
            generateObjectWord (ma, s, s.address.word, s.codeWord1);
            generateObjectWord (ma, s, s.address.word+1, s.codeWord2);

// EXP2-Rkkk  andb R1,3,8,4
	} else if (op.ifmt==arch.iEXP2 && op.afmt==arch.aRkkk & op.pseudo) {
            com.mode.devlog ('Pass2 EXP2/Rkkkk (logicb)');
            const addr = s.address.word;
            const d = requireReg(ma,s,s.operands[0]);
            const e = requireK4 (ma, s, addr, Field_e, s.operands[1]);
            const f = requireK4 (ma, s, addr, Field_f, s.operands[2]);
            const g = requireK4 (ma, s, addr, Field_g, s.operands[3]);
            const h = s.operands[2];
	    s.codeWord1 = mkWord448 (op.opcode[0], d, op.opcode[1]);
            s.codeWord2 = mkWord (e, f, g, h);
            generateObjectWord (ma, s, s.address.word, s.codeWord1);
            generateObjectWord (ma, s, s.address.word+1, s.codeWord2);
            
// EXP2-RC            
	} else if (op.ifmt==arch.iEXP2 && op.afmt==arch.aRC) {
	    com.mode.devlog ("pass2 aRC");
            let x = rcParser.exec  (s.fieldOperands);
            if (x) {
                const {1:e, 2:ctlRegName} = x;
                let ctlRegIdx = findCtlIdx (ma,s,ctlRegName);
	        s.codeWord1 = mkWord448 (14,0,op.opcode[1]);
	        s.codeWord2 = mkWord (e, ctlRegIdx, 0, 0);
	        generateObjectWord (ma, s, s.address.word, s.codeWord1);
	        generateObjectWord (ma, s, s.address.word+1, s.codeWord2);
            } else {
                mkErrMsg (ma, s, `ERROR operation requires RC operands`);
            }

// EXP2-RRk
	} else if (op.ifmt==arch.iEXP2 && op.afmt==arch.aRRk) {
            console.log ("*********EXP2-RRk **********");
	    com.mode.devlog (`pass2 aRRk`);
            const ab = op.opcode[1];
            const d = requireReg (ma, s, s.operands[0]);
            const e = requireReg (ma, s, s.operands[1]);
            const kv = evaluate (ma, s, s.address.word, s.operands[2]);
            const f = kv.word;
            console.log (`Pass 2 RRk d=${d} ab=${ab} e=${e} f=${f}`);
            s.codeWord1 = mkWord448 (op.opcode[0], d, ab);
            s.codeWord2 = mkWord (e, f, 0, 0);
            generateObjectWord (ma, s, s.address.word, s.codeWord1);
	    generateObjectWord (ma, s, s.address.word+1, s.codeWord2);
            // Check proper number of args...

// EXP2-RRkk            
	} else if (op.ifmt==arch.iEXP2 && op.afmt==arch.aRRkk) {
	    com.mode.devlog (`pass2 iEXP2/aRRkk`);
            const x = rrkkParser.exec (s.fieldOperands);
            if (x) {
                const {1:d, 2:e, 3:g, 4:h} = x;
                let f = 0;
	        s.codeWord1 = mkWord448 (op.opcode[0], d, op.opcode[1]);
	        s.codeWord2 = mkWord (e, f, g, h);
	        generateObjectWord (ma, s, s.address.word, s.codeWord1);
	        generateObjectWord (ma, s, s.address.word+1, s.codeWord2);
            } else {
                mkErrMsg (ma, s, `ERROR operation requires RRkk operands`);
            }

        } else if (op.ifmt==arch.iEXP2 && op.afmt==arch.aRRRk) {
            console.log (`pass2 aRRRk`);
            const d = requireReg(ma,s,s.operands[0]);
            const e = requireReg(ma,s,s.operands[1]);
            const f = requireReg(ma,s,s.operands[2]);
            const kv = evaluate (ma, s, s.address.word, s.operands[3]);
            const g = 0;
            const h = kv.word;
	    s.codeWord1 = mkWord448 (op.opcode[0], d, op.opcode[1]);
	    s.codeWord2 = mkWord (e, f, g, h);
	    generateObjectWord (ma, s, s.address.word, s.codeWord1);
	    generateObjectWord (ma, s, s.address.word+1, s.codeWord2);

// EXP2-RRRkk            
        } else if (op.ifmt==arch.iEXP2 && op.afmt==arch.aRRRkk) {
            com.mode.devlog (`pass2 aRRRkk`);
            const x = rrrkkParser.exec (s.fieldOperands);
            if (x) {
                const {1:d, 2:e, 3:f, 4:g, 5:h} = x;
                s.codeWord1 = mkWord448 (op.opcode[0], d, op.opcode[1]);
                s.codeWord2 = mkWord (e, f, g, h);
	        generateObjectWord (ma, s, s.address.word, s.codeWord1);
	        generateObjectWord (ma, s, s.address.word+1, s.codeWord2);
            } else {
                mkErrMsg (ma, s, `ERROR operation requires RRRkk operands`);
            }


// EXP2-RRX save, restore
	} else if (op.ifmt==arch.iEXP2 && op.afmt==arch.aRRX) {
	    com.mode.devlog (`pass2 EXP2/RRX`);
	    console.log (`pass2 EXP2-RRX`);
            const x = rrxParser.exec (s.fieldOperands);
            const d = requireReg(ma,s,s.operands[0]);
            const e = requireReg(ma,s,s.operands[1]);
            const {disp,index} = requireX (ma, s, s.operands[2]);
            const f = index;
            const gh = requireK8 (ma, s, s.address.word+1, arch.Field_gh, disp);
	    s.codeWord1 = mkWord448 (op.opcode[0], d, op.opcode[1]);
            s.codeWord2 = mkWord448 (e, f, gh);
	    generateObjectWord (ma, s, s.address.word, s.codeWord1);
	    generateObjectWord (ma, s, s.address.word+1, s.codeWord2);

// EXP2-kX            
	} else if (op.ifmt==arch.iEXP2 && op.afmt==arch.akX) {
	    com.mode.devlog (`pass2 EXP2/kX`);
            let x = kxParser.exec (s.fieldOperands);
            if (x) {
	        s.codeWord1 = mkWord(op.opcode[0],s.d,s.a,op.opcode[1]);
                let v = evaluate(ma,s,s.address.word+1,s.field_disp);
                s.codeWord2 = v.value;
                if (v.evalRel) {
                    com.mode.devlog (`relocatable displacement`);
                    generateRelocation (ma, s, s.address.word+1);
                }
	        generateObjectWord (ma, s, s.address.word, s.codeWord1);
	        generateObjectWord (ma, s, s.address.word+1, s.codeWord2);
            } else {
                mkErrMsg (ma, s, `ERROR operation requires RX operands`);
            }

// RRREXP ???            
	} else if (op.ifmt==arch.aRRREXP) { // ????????????????????????????
	    com.mode.devlog (`pass2 aRRREXP`);
            s.d  = s.operand_str1;   // first register
	    s.field_e  = s.operand_str2;   // second register
	    s.field_f  = s.operand_str3;   // second register
	    s.field_g  = logicFunction(s.fieldOperation);
	    s.codeWord1 = mkWord448(op.opcode[0],s.d,op.opcode[1]);
            s.codeWord2 = mkWord(s.field_e,s.field_f,s.field_g,0);
	    generateObjectWord (ma, s, s.address.word, s.codeWord1);
	    generateObjectWord (ma, s, s.address.word+1, s.codeWord2);


// Data-Data            
        } else if (op.ifmt==arch.iData && op.afmt==arch.aData) {
            com.mode.trace = true;
            com.mode.devlog (`Pass2 ${s.lineNumber} data`);
            let v = evaluate(ma,s,s.address,s.fieldOperands);
            com.mode.devlog (`data v = ${v.toString()}`);
//            s.codeWord1 = v.getval();
            s.codeWord1 = v.word;
	    generateObjectWord (ma, s, s.address.word, s.codeWord1);
            //            if (v.getIsRelocatable()) {
            if (v.movability==Relocatable) {
                com.mode.devlog (`relocatable data`);
                generateRelocation (ma, s, s.address.word);
            }
            com.mode.trace = false;

// Dir-Export            
        } else if (op.ifmt==arch.iDir && op.afmt==arch.aExport) {
            com.mode.devlog ('pass2 export statement')
            const x = identParser.exec (s.fieldOperands);
            if (x) {
                com.mode.devlog (`export identarg=${s.identarg}`);
                const {0:ident} = x;
                ma.exports.push(ident);
            } else {
                mkErrMsg (ma, s, `ERROR export requires identifier operand`);
            }

// Unknown format            
	} else {
	    com.mode.devlog('pass2 other, noOperation');
	}

	s.listingLinePlain =  (s.lineNumber+1).toString().padStart(4,' ')
	    + ' ' + arith.wordToHex4(s.address.word)
            + (s.address.movability==Fixed ? "." : " ")
	    + ' ' + (s.codeSize.word>0 ? arith.wordToHex4(s.codeWord1) : '    ')
	    + ' ' + (s.codeSize.word>1 ? arith.wordToHex4(s.codeWord2) : '    ')
            + ' '
	    + s.fieldLabel
	    + s.fieldSpacesAfterLabel
	    + s.fieldOperation
	    + s.fieldSpacesAfterOperation
	    + s.fieldOperands
	    + fixHtmlSymbols (s.fieldComment);
	s.listingLineHighlightedFields = (s.lineNumber+1).toString().padStart(4,' ')
	    + ' ' + arith.wordToHex4(s.address.word)
	    + ' ' + (s.codeSize.word>0 ? arith.wordToHex4(s.codeWord1) : '    ')
	    + ' ' + (s.codeSize.word>1 ? arith.wordToHex4(s.codeWord2) : '    ')
            + ' '
	    + com.highlightField (s.fieldLabel, "FIELDLABEL")
	    + s.fieldSpacesAfterLabel
	    + com.highlightField (s.fieldOperation, "FIELDOPERATION")
	    + s.fieldSpacesAfterOperation
	    + com.highlightField (s.fieldOperands, "FIELDOPERAND")
	    + com.highlightField (fixHtmlSymbols(s.fieldComment), "FIELDCOMMENT") ;

	ma.asmListingText.push(s.listingLinePlain);
	ma.asmListingPlain.push(s.listingLinePlain);
	ma.asmListingDec.push(s.listingLineHighlightedFields);
	for (let i = 0; i < s.errors.length; i++) {
	    ma.asmListingText.push('Error: ' + s.errors[i],'ERR');
            	    ma.asmListingPlain.push (com.highlightField
                                     ('Error: ' + s.errors[i],'ERR'));
            ma.asmListingDec.push(com.highlightField
                                  ('Error: ' + s.errors[i],'ERR'));
	}
    }
    emitObjectWords (ma);
    emitRelocations (ma);
    emitExports (ma);
    emitImports (ma);
    ma.objectCode.push ("");
    ma.objectText = ma.objectCode.join("\n");
    emitMetadata (ma);
    ma.metadataText = ma.metadata.join("\n");
}

// handleVal: Generate relocation or import if necessary

function handleVal (ma, s, a, vsrc, v, field) {
    com.mode.trace = true;
    com.mode.devlog (`handleVal ${a} /${vsrc}/ ${field.description}`);
    if (v.origin==Local && v.movability==Relocatable) {
        generateRelocation (ma, s, a);
    } else if (v.origin==External) {
        let sym = ma.symbolTable.get(vsrc);
        if (sym) {
            let modstr = sym.mod;
            let extname = sym.extname;
            let astr = arith.wordToHex4(a);
            let fstr = field.description
            let x = `import ${modstr},${extname},${astr},${fstr}`;
            ma.imports.push(x);
            console.log (`handleVal generate ${x}`);
        } else { // should be impossible: internal error
            mkErrMsg (`external symbol ${vsrc} undefined`);
            console.log (`external symbol ${vsrc} undefined - impossible`);
        }
    }
    com.mode.trace = false;
}

function fixHtmlSymbols (str) {
    let x;
    x = str.replace(/</g, "&lt;")
    return x;
}

// Add object word x to buffer for next object code line in module m.
// The asm statement is s, and the object word will be loaded at
// address a.  The line number entered into asmap is ln = s.lineNumber
// + 1 to account for the header line that is inserted before the
// statements in the listing.

function generateObjectWord (ma, s, a, x) {
    objectWordBuffer.push (x);
    ma.asArrMap[a] = s.lineNumber;
}

function emitObjectWords (ma) {
    let xs, ys, zs;
    while (objectWordBuffer.length > 0) {
        xs = objectWordBuffer.splice(0,objBufferLimit);
        ys = xs.map( (w) => arith.wordToHex4(w));
        zs = 'data     ' + ys.join(',');
        ma.objectCode.push (zs);
    }
}

// Record an address that needs to be relocated

function generateRelocation (ma, s, a) {
    com.mode.devlog (`generateRelocation ${a}`);
    relocationAddressBuffer.push (a);
}

// Generate the relocation statements in object code

function emitRelocations (ma) {
    let xs, ys, zs;
    while (relocationAddressBuffer.length > 0) {
        let xs = relocationAddressBuffer.splice(0,objBufferLimit);
        let ys = xs.map((w) => arith.wordToHex4(w));
        let zs = 'relocate ' + ys.join(',')
        ma.objectCode.push (zs);
    }
}

// Generate import statements in object code

function emitImports (ma) {
    console.log ("emitImports");
    for (let x of ma.imports) {
        ma.objectCode.push(x);
    }
}
//        let sym = ma.symbolTable.get(x);
//        let v = sym.value.value;
//        let z = `import   ${sym.name},${v}`;
//        ma.objectCode.push(z);

function emitExports (ma) {
    let x, y, sym, w, r;
    com.mode.trace = true;
    com.mode.devlog ('emitExports' + ma.exports);
    while (ma.exports.length > 0) {
        x = ma.exports.splice(0,1);
        y = x[0];
        com.mode.devlog (`emit exports looking up  x=<${x}> y=${y}`);
        com.mode.devlog (ma.symbolTable);
        sym = ma.symbolTable.get(y);
        if (sym) {
            r = sym.value.movability==Relocatable ? "relocatable" : "fixed";
            w = arith.wordToHex4(sym.value.word);
            com.mode.devlog (`emit exports y=${y} r=${r} w=${w}`);
            ma.objectCode.push (`export   ${y},${w},${r}`);
        } else {
            mkErrMsg (ma, s, `export identifier ${y} is undefined`);
        }
    }
    com.mode.trace = false;
}

// The size of text lines in object code and metadata is limited to
// NitemsPerLine values.  This has two purposes: it makes the object
// code and metadata more readable, and it helps avoid buffer overrun
// while reading in the data in C programs.

const NitemsPerLine = 10;

function emitMetadata (ma) {
    com.mode.devlog ("emitMetadata");
    let xs, ys;
    xs = [...ma.asArrMap];
    ma.metadata.push (`asmap ${xs.length}`);
    while (xs.length > 0) {
        let ys = xs.slice (0, NitemsPerLine);
        xs.splice (0, NitemsPerLine);
        ma.metadata.push (ys);
    }
    xs = [...ma.asmListingPlain];
    ys = [...ma.asmListingDec];
    ma.metadata.push (`source ${xs.length}`);
    for (let i = 0; i < xs.length; i++) {
        ma.metadata.push(xs[i]);
        ma.metadata.push(ys[i]);
    }
}

// Convert  the address-source map x to a string

export function showAsMap (x) {
    console.log ('Address~Source map');
    for (let i = 0; i < x.length; i++) {
        console.log (`address ${arith.wordToHex4(i)} => ${x[i]}`);
    }
}

export function setAsmListing () {
    com.mode.devlog ("setAsmListing");
    let listingDec = smod.getSelectedModule().asmInfo.asmListingDec;
    let listing = listingDec ? listingDec.join('\n') : 'no listing';
    document.getElementById('AsmTextHtml').innerHTML = listing;
}

export function setObjectListing () {
    let code = smod.getSelectedModule().asmInfo.objectCode;
    let codeText = code ? code.join('<br>') : 'no code';
    let listing = "<pre class='HighlightedTextAsHtml'>" + codeText + "</pre>";
    document.getElementById('AsmTextHtml').innerHTML = listing;
}

export function setMetadata () {
    let code = smod.getSelectedModule().asmInfo.metadata;
    let codeText = code ? code.join('<br>') : 'no code';
    let listing = "<pre class='HighlightedTextAsHtml'>" + codeText + "</pre>";
    document.getElementById('AsmTextHtml').innerHTML = listing;
}

function showOperation (op) {
    return `ifmt=${op.ifmt.description} afmt=${op.afmt.description}`
    + `opcode=${op.opcode} pseudo=${op.pseudo}`;
}

/*  Deprecated

// const rrrParser =
    /^R([0-9a-f]|(?:1[0-5])),R([0-9a-f]|(?:1[0-5])),R([0-9a-f]|(?:1[0-5]))$/;

    deprecated */
