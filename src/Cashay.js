import {INSERT_NORMALIZED} from './normalize/duck';
import denormalizeStore from './normalize/denormalizeStore';
import {rebuildOriginalArgs} from './normalize/denormalizeHelpers';
import normalizeResponse from './normalize/normalizeResponse';
import {printMinimalQuery} from './query/printMinimalQuery';
import {buildExecutionContext} from './buildExecutionContext';
import {makeNormalizedDeps, shortenNormalizedResponse} from './query/queryHelpers';
import {isObject, checkMutationInSchema} from './utils';
import mergeStores from './normalize/mergeStores';
import {CachedMutation, CachedQuery} from './helperClasses';
import flushDependencies from './query/flushDependencies';
import {makeComponentsToUpdate} from './mutate/mutationHelpers';
import {parse, arraysShallowEqual} from './utils';
import namespaceMutation from './mutate/namespaceMutation';
import mergeMutations from './mutate/mergeMutations';
import createMutationFromQuery from './mutate/createMutationFromQuery';

const defaultGetToState = store => store.getState().cashay;
const defaultPaginationWords = {
  before: 'before',
  after: 'after',
  first: 'first',
  last: 'last'
};

export default class Cashay {
  constructor({store, transport, schema, getToState = defaultGetToState, paginationWords, idFieldName = 'id'}) {
    // the redux store
    this.store = store;

    //the cashay state
    this.state = getToState(store);

    // the reserved arguments for cusor-based pagination
    this.paginationWords = Object.assign({}, defaultPaginationWords, paginationWords);

    // the field that contains the UID
    this.idFieldName = idFieldName;

    // the default function to send the queryString to the server (usually HTTP or WS)
    this.transport = transport;

    // the client graphQL schema
    this.schema = schema;

    // many mutations can share the same mutationName, making it hard to cache stuff without adding complexity
    // const example = {
    //   [mutationName]: {
    //     activeComponents: [],
    //     setKey: Set(...[componentIds]), // TODO get rid of this & just invalidate when new handles are added
    //     fullMutation: MutationString,
    //     variableEnhancers: []
    //     singles: {
    //       [componentId]: {
    //          ast: MutationAST,
    //          variableEnhancers: null || []
    //       }
    //     }
    //   }
    // }
    this.cachedMutations = {};

    // the object to hold the denormalized query responses
    // const example = {
    //   [componentId]: {
    //     ast,
    //     refetch: FunctionToRefetchQuery
    //     response: DenormalizedResponse,
    //   }
    // }
    this.cachedQueries = {};

    // a flag thrown by the invalidate function and reset when that query is added to the queue
    this._willInvalidateListener = false;

    // a queue of query function calls to refetch after a mutation invalidated their data
    this._invalidationQueue = [];

    // const example = {
    //   [mutationName]: {
    //     [componentId]: mutationHandlerFn
    //   }
    // }
    this.mutationHandlers = {};

    // denormalized deps is an object with entities for keys. 
    // The value of each entity is an object with uids for keys.
    // the value of each UID is a set of componentIds
    // const example = {
    //   Pets: {
    //     1: Set("componentId1", "componentId2")
    //   }
    // }
    this.denormalizedDeps = {};

    // not stored in _cachedQueries in able to compare old vs new deps
    // const example = {
    //   [componentId]: Set(...[['Pets','1'], ['Pets', '2']])
    // }
    this.normalizedDeps = {};
  }

  /**
   * a method given to a mutation callback that turns on a global.
   * if true, then we know to queue up a requery
   */
  _invalidate() {
    this._willInvalidateListener = true;
  }

  /**
   * A method that accepts a GraphQL query and returns a result using only local data.
   * If it cannot complete the request on local data alone, it also asks the server for the data that it does not have.
   *
   * @param {String} queryString The GraphQL query string, exactly as you'd send it to a GraphQL server
   * @param {Object} options The optional objects to include with the query
   *
   * @property {String} options.componentId A string to uniquely match the queryString to the component.
   * @property {Boolean} options.forceFetch is true if the query is to ignore all local data and fetch new data
   * @property {String} options.idFieldName is the name of the field that contains the unique ID (default is 'id')
   * @property {Object} options.paginationWords is an object that contains custom names for 'before, after, first, last'
   * @property {Function} options.transport The function used to send the data request to GraphQL, if different from default
   * @property {Object} options.variables are the variables sent along with the query
   * @property {Object} options.mutationHandlers the functions used to change the local data when a mutation occurs
   * @property {Object} options.customMutations if mutations are too complex to be autogenerated (rare), write them here
   *
   * @returns {Object} The denormalized object like GraphQL would return, with additional `isComplete` and `firstRun` flags
   *
   */
  query(queryString, options = {}) {
    //if you call forceFetch in a mapStateToProps, you're gonna have a bad time (it'll refresh on EVERY dispatch)
    const {forceFetch} = options;

    // Each component can have only 1 unique queryString/variable combo. This keeps memory use minimal.
    // if 2 components have the same queryString/variable but a different componentId, it'll fetch twice
    const componentId = options.componentId || queryString;

    // get the result, containing a response, queryString, and options to re-call the query
    const fastResult = this.cachedQueries[componentId];

    // if we got local data cached already, send it back fast
    if (!forceFetch && fastResult && fastResult.response) {
      return fastResult.response;
    }

    // override singleton defaults with query-specific values
    const variables = this.state.data.variables[componentId] || options.variables;
    // const paginationWords = Object.assign({}, this.paginationWords, options.paginationWords);
    // const idFieldName = options.idFieldName || this.idFieldName;
    const transport = options.transport || this.transport;

    // save the query so we can call it from anywhere
    const cachedQuery = this.cachedQueries[componentId] = this.cachedQueries[componentId] ||
      new CachedQuery(this.query, queryString, {transport, forceFetch: true});

    // create an AST that we can mutate
    const {paginationWords, idFieldName, state: {data: cashayDataState}} = this;
    const context = buildExecutionContext(cachedQuery.ast, cashayDataState, {variables, paginationWords, idFieldName})

    cachedQuery.createResponse(context, componentId, this.store.dispatch, forceFetch);


    // if this is a different query string but the same base query
    // eg in this one we request 1 more field
    // we'll want to add dependencies since we don't know when the server response will come back
    if (!cachedQuery.response.firstRun) {
      // normalize the cachedQuery.response so we can add dependencies and stick it in the store
      const normalizedPartialResponse = normalizeResponse(cachedQuery.response.data, context);
      this._addDeps(normalizedPartialResponse, componentId);
    }

    // if we need more data, get it from the server
    if (!cachedQuery.response.isComplete) {
      // given an operation enhanced with sendToServer flags, print minimal query
      const serverQueryString = (forceFetch || cachedQuery.response.firstRun) ?
        queryString : printMinimalQuery(context.operation, idFieldName);

      //  async query the server (no need to track the promise it returns, as it will change the redux state)
      this.queryServer(transport, context, serverQueryString, componentId);
    }

    // go through a Set of componentIds to see if we already have this one
    // if (isObject(mutationHandlers) && !this._processedHandlers.has(componentId)) {
    // add the mutation listeners to the Cashay object
    const {mutationHandlers, customMutations} = options;
    this._prepareMutations(componentId, mutationHandlers, customMutations);
    return cachedQuery.response;
  }

  /**
   * A method used to get missing data from the server.
   * Once the data comes back, it is normalized, old dependencies are removed, new ones are created,
   * and the data that comes back from the server is compared to local data to minimize invalidations
   *
   * @param {function} transport the transport function to send the query + vars to a GraphQL endpoint
   * @param {object} context the context to normalize data, including the requestAST and schema
   * @param {string} minimizedQueryString the query string to send to the GraphQL endpoint
   * @param {string} componentId an ID specific to the queryString/variable combo (defaults to the queryString)
   * @param {object} normalizedPartialResponse the local data that we already have to fulfill the request
   *
   * @return {undefined}
   */
  async queryServer(transport, context, minimizedQueryString, componentId) {
    const {variables} = context;

    // send minimizedQueryString to server and await minimizedQueryResponse
    const minimizedQueryResponse = await transport(minimizedQueryString, variables);

    const cachedQuery = this.cachedQueries[componentId];
    // handle errors coming back from the server
    if (!minimizedQueryResponse.data) {
      console.log(JSON.stringify(minimizedQueryResponse.errors));
      cachedQuery.error = JSON.stringify(minimizedQueryResponse.errors);
      // TODO put error in redux state
      return;
    }

    //re-create the denormalizedPartialResponse because it went stale when we called the server
    const {data} = denormalizeStore(context);
    const normalizedPartialResponse = normalizeResponse(data, context);

    // normalize response to get ready to dispatch it into the state tree
    const normalizedMinimizedQueryResponse = normalizeResponse(minimizedQueryResponse.data, context);

    // now, remove the objects that look identical to the ones already in the state
    // if the incoming entity (eg Person.123) looks exactly like the one already in the store, then
    // we don't have to invalidate and rerender
    const normalizedResponseForStore = shortenNormalizedResponse(normalizedMinimizedQueryResponse, this.state.data);

    // if the server didn't give us any new stuff, we already set the vars, so we're done here
    if (!normalizedResponseForStore) return;
    // combine the partial response with the server response to fully respond to the query
    const fullNormalizedResponse = mergeStores(normalizedPartialResponse, normalizedMinimizedQueryResponse);

    // it's possible that we adjusted the arguments for the operation we sent to server
    // for example, instead of asking for 20 docs, we asked for 5 at index 15.
    // now, we want to ask for the 20 again
    rebuildOriginalArgs(context.operation);

    // read from a pseudo store (eliminates a requery)
    // even if the requery wasn't expensive, doing it here means we don't have to keep track of the fetching status
    // eg if fetching is true, then we always return the cached result
    const reducedContext = Object.assign(context, {cashayDataState: fullNormalizedResponse});
    cachedQuery.createResponse(reducedContext, componentId, this.store.dispatch);

    // add denormalizedDeps so we can invalidate when other queries come in
    // add normalizedDeps to find those deps when a denormalizedReponse is mutated
    // the data fetched from server is only part of the story, so we need the full normalized response
    this._addDeps(fullNormalizedResponse, componentId);

    // remove the responses from this.cachedQueries where necessary 
    flushDependencies(normalizedResponseForStore, componentId, this.denormalizedDeps, this.cachedQueries);

    // stick normalize data in store and recreate any invalidated denormalized structures
    this.store.dispatch({
      type: INSERT_NORMALIZED,
      payload: {
        response: normalizedMinimizedQueryResponse,
        componentId,
        variables
      }
    });
  }

  _addDeps(normalizedResponse, componentId) {
    // get the previous set
    const oldNormalizedDeps = this.normalizedDeps[componentId];

    // create a set of normalized locations in entities (eg 'Post.123')
    const newNormalizedDeps = this.normalizedDeps[componentId] = makeNormalizedDeps(normalizedResponse.entities);

    let newUniques;
    if (!oldNormalizedDeps) {
      newUniques = newNormalizedDeps;
    } else {
      // create 2 Sets that are the left/right diff of old and new
      newUniques = new Set();
      for (let dep of newNormalizedDeps) {
        if (oldNormalizedDeps.has(dep)) {
          oldNormalizedDeps.delete(dep);
        } else {
          newUniques.add(dep);
        }
      }

      // remove old deps
      for (let dep of oldNormalizedDeps) {
        const [entity, item] = dep.split('.');
        this.denormalizedDeps[entity][item].delete(componentId);
      }
    }

    // add new deps
    for (let dep of newUniques) {
      const [entity, item] = dep.split('.');
      this.denormalizedDeps[entity] = this.denormalizedDeps[entity] || {};
      this.denormalizedDeps[entity][item] = this.denormalizedDeps[entity][item] || new Set();
      this.denormalizedDeps[entity][item].add(componentId);
    }
  }

  _prepareMutations(componentId, mutationHandlers, customMutations) {
    const {mutationSchema} = this.schema;
    if (isObject(mutationHandlers)) {
      const mutationHandlerNames = Object.keys(mutationHandlers);
      for (let mutationName of mutationHandlerNames) {
        checkMutationInSchema(mutationSchema, mutationName);
        this.mutationHandlers[mutationName] = this.mutationHandlers[mutationName] || {};
        this.mutationHandlers[mutationName][componentId] = mutationHandlers[mutationName];
      }
    }
    if (isObject(customMutations)) {
      const mutationNames = Object.keys(customMutations);
      for (let mutationName of mutationNames) {
        checkMutationInSchema(mutationSchema, mutationName);
        this.cachedMutations[mutationName] = this.cachedMutations[mutationName] || new CachedMutation();
        const cachedSingles = this.cachedMutations[mutationName].singles;
        if (!cachedSingles[componentId]) {
          const mutationAST = parse(customMutations[mutationName]);
          const {operation, variableEnhancers} = namespaceMutation(mutationAST, componentId, this.state, this.schema);
          cachedSingles[componentId] = {
            ast: operation,
            variableEnhancers
          }
        }
      }
    }
  }

  /**
   *
   * A mutationName is not unique to a mutation, but a name + possibleComponentIds is
   *
   */
  mutate(mutationName, possibleComponentIds, options = {}) {
    const {variables} = options;
    const cachedMutation = this.cachedMutations[mutationName];
    const {fullMutation, cachedComponentIds, singles} = cachedMutation;
    let mutationString;
    if (fullMutation) {
      if (possibleComponentIds === cachedComponentIds) {
        mutationString = fullMutation;
      } else if (arraysShallowEqual(possibleComponentIds, cachedComponentIds)) {
        console.warn(`For a performance boost, create your ${mutationName} mutation 
        componentId array outside the render function`);
        mutationString = fullMutation;
      }
    }
    if (!mutationString) {
      const componentIdsToUpdate = makeComponentsToUpdate(mutationName, possibleComponentIds, this.cachedQueries, this.mutationHandlers);
      if (!componentIdsToUpdate) {
        throw new Error(`Mutation has no queries to update: ${mutationName}`);
      }
      //TODO
      this._createMutationsFromQueries(componentIdsToUpdate, mutationName, variables);

      const cachedSingles = {};
      for (let componentId of componentIdsToUpdate) {
        const {ast, variableEnhancers} = singles[componentId];
        cachedSingles[componentId] = ast;
        cachedMutation.variableEnhancers.push(...variableEnhancers);
      }
      mergeMutations(cachedSingles, this.schema);
      // TODO handle performance boost if only 1 componentIdToUpdate
    }
    const namespacedVariables = cachedMutation.variableEnhancers.reduce((enhancer, reduction) => enhancer(reduction), variables);


    // const mutationString = createMutationString.call(this, mutationName, componentIdsToUpdate);

    // optimistcally update
    this._addListenersHandler(mutationName, componentIdsToUpdate, null, variables);

    // async call the server
    this._mutateServer(mutationName, componentIdsToUpdate, mutationString, options);
  }

  _createMutationsFromQueries(componentIds, mutationName, variables) {
    const {mutationSchema} = this.schema;
    // createComment
    const mutationFieldSchema = mutationSchema.fields[mutationName];

    this.cachedMutations[mutationName] = this.cachedMutations[mutationName] || new CachedMutation();
    const cachedSingles = this.cachedMutations[mutationName].singles;
    for (let componentId of componentIds) {
      if (!cachedSingles[componentId]) {
        const {ast} = this.cachedQueries[componentId];
        // TODO where to handle parseAndAlias? Inside i think
        const mutationAST = createMutationFromQuery(ast, mutationName, this.schema);
        const {namespaceAST, variableEnhancers} = namespaceMutation(mutationAST, componentId, this.state.variables, this.schema);
        cachedSingles[componentId] = {
          ast: namespaceAST,
          variableEnhancers
        }
      }
    }
  };

  async _mutateServer(mutationName, componentIdsToUpdate, mutationString, options) {
    const {variables} = options;
    const transport = this._getTransport(options);
    const docFromServer = await transport(mutationString, variables);
    // update state with new doc from server
    this._addListenersHandler(mutationName, componentIdsToUpdate, docFromServer);

    // the queries to forcefully refetch
    while (this._invalidationQueue.length) {
      const queryToRefetch = this._invalidationQueue.shift();
      queryToRefetch();
    }
  }

  _addListenersHandler(mutationName, componentIdsToUpdate, docFromServer, variables) {
    const listenerMap = this.mutationHandlers[mutationName];
    const cashayDataState = this.state.data;
    let allNormalizedChanges = {};
    // for every component that listens the the mutationName
    for (let componentId of componentIdsToUpdate) {
      const resolve = listenerMap[componentId];
      // find current cached result for this particular componentId
      const cachedResult = this.cachedQueries[componentId];
      const {queryString, response: {data}, options: {paginationWords, idFieldName, transport}} = cachedResult;
      if (docFromServer) debugger
      // for the denormalized response, mutate it in place or return undefined if no mutation was made
      const modifiedResponse = docFromServer ?
        // if it's from the server, send the doc we got back
        resolve(null, docFromServer.data, data, cashayDataState, this._invalidate) :
        // otherwise, treat it as an optimistic update
        resolve(variables, null, data, cashayDataState, this._invalidate);

      // see if we want to rerun the listening query again. if so, put it in a map & we'll run them after
      // this means there's a possible 3 updates: optimistic, doc from server, full array from server (invalidated)
      if (this._willInvalidateListener) {
        this._willInvalidateListener = false;
        this._invalidationQueue.set(componentId, () => {
          this.query(queryString, {
            componentId,
            paginationWords,
            idFieldName,
            transport,
            forceFetch: true
          })
        })
      }

      // this must come back after the invalidateListener check because they could invalidate without returning something
      if (!modifiedResponse) {
        continue;
      }

      // create a new object to make sure react-redux's updateStatePropsIfNeeded returns true
      this.cachedQueries[componentId].response = Object.assign({}, this.cachedQueries[componentId].response);

      // TODO: normalizing requires context, requires the queryAST, but we don't wanna parse that over & over!
      // let's parse for alpha, then figure out whether to store it or do something intelligent
      // like store the AST for hot queries
      // if a mutation was made, normalize it & send it off to the store
      const context = buildExecutionContext(this.schema, queryString, {
        variables: cashayDataState.variables[componentId],
        paginationWords,
        idFieldName,
        cashayDataState
      });

      const normalizedModifiedResponse = normalizeResponse(modifiedResponse, context);
      allNormalizedChanges = mergeStores(allNormalizedChanges, normalizedModifiedResponse);
    }

    const normalizedResponseForStore = shortenNormalizedResponse(allNormalizedChanges, cashayDataState);
    // merge the normalized optimistic result with the state
    // dont invalidate other queries, they might not want it.
    // if they want it, they'll ask for it in their own listener
    if (normalizedResponseForStore) {
      this.store.dispatch({
        type: '@@cashay/INSERT_NORMALIZED',
        payload: {
          response: normalizedResponseForStore
        }
      });
    }
  }
}
