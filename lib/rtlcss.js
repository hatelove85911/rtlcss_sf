/*
 * RTLCSS 2.0.5 https://github.com/MohammadYounes/rtlcss
 * Framework for transforming Cascading Style Sheets (CSS) from Left-To-Right (LTR) to Right-To-Left (RTL).
 * Copyright 2016 Mohammad Younes.
 * Licensed under MIT <http://opensource.org/licenses/mit-license.php>
 * */
'use strict'
var postcss = require('postcss')
// var directiveParser = require('./directive-parser.js')
var state = require('./state.js')
var config = require('./config.js')
var util = require('./util.js')

module.exports = postcss.plugin('rtlcss', function (options, plugins) {
  var configuration = config.configure(options, plugins)
  var context = {
    // provides access to postcss
    'postcss': postcss,
    // provides access to the current configuration
    'config': configuration,
    // provides access to utilities object
    'util': util.configure(configuration)
  }
  return function (css, result) {
    var flipped = 0
    var toBeRenamed = {}


    // remove .rtl started rules first to avoid duplicate .rtl rules
    css.walkRules(function(rule){
      if(rule.selector.trim().substring(0,4) === '.rtl') {
        rule.remove()
      }
    })

    // array to store unflipped and flipped decl
    var unflippedDecls = []
    var flippedRtlDecls = []
    var flippedLtrDecls = []

    css.walk(function (node) {
      var prevent = false
      state.walk(function (current) {
        // check if current directive is expecting this node
        if (!current.metadata.blacklist && current.directive.expect[node.type]) {
          // perform action and prevent further processing if result equals true
          if (current.directive.begin(node, current.metadata, context)) {
            prevent = true
          }
          // if should end? end it.
          if (current.metadata.end && current.directive.end(node, current.metadata, context)) {
            state.pop(current)
          }
        }
      })

      if (prevent === false) {
        switch (node.type) {
          case 'atrule':
            // @rules requires url flipping only
            if (context.config.processUrls === true || context.config.processUrls.atrule === true) {
              var params = context.util.applyStringMap(node.params, true)
              node.params = params
            }
            break
          case 'comment':
            state.parse(node, result, function (current) {
              var push = true
              if (current.directive === null) {
                current.preserve = !context.config.clean
                context.util.each(context.config.plugins, function (plugin) {
                  var blacklist = context.config.blacklist[plugin.name]
                  if (blacklist && blacklist[current.metadata.name] === true) {
                    current.metadata.blacklist = true
                    if (current.metadata.end) {
                      push = false
                    }
                    if (current.metadata.begin) {
                      result.warn('directive "' + plugin.name + '.' + current.metadata.name + '" is blacklisted.', {node: current.source})
                    }
                    // break each
                    return false
                  }
                  current.directive = plugin.directives.control[current.metadata.name]
                  if (current.directive) {
                    // break each
                    return false
                  }
                })
              }
              if (current.directive) {
                if (!current.metadata.begin && current.metadata.end) {
                  if (current.directive.end(node, current.metadata, context)) {
                    state.pop(current)
                  }
                  push = false
                } else if (current.directive.expect.self && current.directive.begin(node, current.metadata, context)) {
                  if (current.metadata.end && current.directive.end(node, current.metadata, context)) {
                    push = false
                  }
                }
              } else if (!current.metadata.blacklist) {
                push = false
                result.warn('unsupported directive "' + current.metadata.name + '".', {node: current.source})
              }
              return push
            })
            break
          case 'decl':
            // if broken by a matching value directive .. break
            if (!context.util.each(context.config.plugins,
                function (plugin) {
                  return context.util.each(plugin.directives.value, function (directive) {
                    if (node.raws.value && node.raws.value.raw) {
                      var expr = context.util.regexDirective(directive.name)
                      if (expr.test(node.raws.value.raw)) {
                        expr.lastIndex = 0
                        if (directive.action(node, expr, context)) {
                          if (context.config.clean) {
                            node.raws.value.raw = context.util.trimDirective(node.raws.value.raw)
                          }
                          flipped++
                          // break
                          return false
                        }
                      }
                    }
                  })
                })) break

            // loop over all plugins/property processors

            // clone the decl and push it into flippedRtlDecls array
            var clonedDecl = node.clone()

            var unFlippedFlag = context.util.each(context.config.plugins, function (plugin) {
              return context.util.each(plugin.processors, function (directive) {
                if (node.prop.match(directive.expr)) {
                  var raw = node.raws.value && node.raws.value.raw ? node.raws.value.raw : node.value
                  var state = context.util.saveComments(raw)
                  var pair = directive.action(node.prop, state.value, context)
                  state.value = pair.value
                  pair.value = context.util.restoreComments(state)
                  if (pair.prop !== node.prop || pair.value !== raw) {
                    flipped++

                    // push the original node to flippedLtrDecls
                    flippedLtrDecls.push(node)

                    // push the cloned and modified decl to flippedRtlDecls
                    clonedDecl.prop = pair.prop
                    clonedDecl.value = pair.value
                    flippedRtlDecls.push(clonedDecl)

                    // comment out the original replace logic
                    // node.prop = pair.prop
                    // node.value = pair.value
                  }
                  // match found, break
                  return false
                }
              })
            })

            if(unFlippedFlag) {
              unflippedDecls.push(node)
            }

            // at the end of a rule, if there's rtl transformation happening,
            // then clone a rule and prefix with .rtl
            // and prefix the original rule with .ltr if its initial selector is not .ltr
            if(context.util.isLastOfType(node) && flipped > 0){
              // clone a new rule and prefix it with .rtl
              var clonedParent = node.parent.cloneBefore()
              clonedParent.removeAll()

              if(node.parent.selector.trim().substring(0, 4) === '.ltr') {
                clonedParent.selector = clonedParent.selector.replace('ltr', 'rtl')
              } else {
                clonedParent.selector = '.rtl ' + clonedParent.selector
              }

              flippedRtlDecls.forEach(function(decl){
                clonedParent.append(decl)
              })

              // check if the original rule starts with .ltr
              // if it starts with .ltr, then do nothing
              // otherwise remove the decls which flipped and extract them into a new rule start with .ltr
              if(node.parent.selector.trim().substring(0, 4) !== '.ltr') {
                var clonedOriginalRule = node.parent.cloneBefore()
                clonedOriginalRule.removeAll()

                flippedLtrDecls.forEach(function(decl){
                  node.parent.removeChild(decl)
                  clonedOriginalRule.append(decl)
                })
                clonedOriginalRule.selector = '.ltr ' + clonedOriginalRule.selector 
              }
            }
            // if last decl, apply auto rename
            // decl. may be found inside @rules
            if (context.config.autoRename && !flipped && node.parent.type === 'rule' && context.util.isLastOfType(node)) {
              var renamed = context.util.applyStringMap(node.parent.selector)
              if (context.config.autoRenameStrict === true) {
                var pair = toBeRenamed[renamed]
                if (pair) {
                  pair.selector = node.parent.selector
                  node.parent.selector = renamed
                } else {
                  toBeRenamed[node.parent.selector] = node.parent
                }
              } else {
                node.parent.selector = renamed
              }
            }
            break
          case 'rule':
            // new rule, reset flipped decl count to zero
            flipped = 0
            // new rule, reset flipped and unflipped decl array
            unflippedDecls = []
            flippedRtlDecls = []
            flippedLtrDecls = []

            break
        }
      }
    })
    state.walk(function (item) {
      result.warn('unclosed directive "' + item.metadata.name + '".', {node: item.source})
    })
    Object.keys(toBeRenamed).forEach(function (key) {
      result.warn('renaming skipped due to lack of a matching pair.', {node: toBeRenamed[key]})
    })
  }
})

/**
 * Creates a new RTLCSS instance, process the input and return its result.
 * @param {String}  css  A string containing input CSS.
 * @param {Object}  options  An object containing RTLCSS settings.
 * @param {Object|Array}  plugins An array containing a list of RTLCSS plugins or a single RTLCSS plugin.
 * @returns	{String}	A string contining the RTLed css.
 */
module.exports.process = function (css, options, plugins) {
  return postcss([this(options, plugins)]).process(css).css
}

/**
 * Creates a new instance of RTLCSS using the passed configuration object
 * @param {Object}  config  An object containing RTLCSS options and plugins.
 * @returns {Object}  A new RTLCSS instance.
 */
module.exports.configure = function (config) {
  config = config || {}
  return postcss([this(config.options, config.plugins)])
}
